// Isolated four-container fixture, based on the real Compose and Dockerfiles.
import assert from 'node:assert/strict'
import { randomBytes, createHmac } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { request as httpsRequest } from 'node:https'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const project = 'dev-toolbox-v3-acceptance'

export function docker(args, input) {
  const result = spawnSync('docker', ['--context', 'orbstack', ...args], { encoding: 'utf8', input, maxBuffer: 8*1024*1024 })
  if (result.status !== 0) throw new Error(`Docker ${args[0]} failed: ${result.stderr.slice(-1800)}`)
  return result.stdout.trim()
}
export function compose(state, args, input) {
  return docker(['compose', '-p', project, '--env-file', join(state.directory,'test.env'), '-f', join(root,'deploy/compose.yaml'), '-f', join(state.directory,'override.yaml'), ...args], input)
}
export async function loadState(path) { return JSON.parse(await readFile(path,'utf8')) }
export async function saveState(state) { await writeFile(join(state.directory,'state.json'), JSON.stringify(state), { mode: 0o600 }) }
export function totp(secret) {
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits=''
  for (const char of secret.replace(/=+$/,'')) bits += alphabet.indexOf(char).toString(2).padStart(5,'0')
  const key=Buffer.from((bits.match(/.{8}/g)??[]).map(b=>parseInt(b,2)))
  const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)))
  const digest=createHmac('sha1',key).update(counter).digest(),offset=digest.at(-1)&15
  return ((digest.readUInt32BE(offset)&0x7fffffff)%1000000).toString().padStart(6,'0')
}
export async function api(state, path, payload, method = payload === undefined ? 'GET' : 'POST') {
  const response=await fetch(state.origin+path,{ method, headers:{'Content-Type':'application/json',Origin:state.origin,Cookie:state.cookie??'','X-CSRF-Token':state.csrf??''},body:payload===undefined?undefined:JSON.stringify(payload),signal:AbortSignal.timeout(30000) })
  const cookie=response.headers.getSetCookie().find(c=>c.startsWith('__Host-dev-toolbox-session='))
  if(cookie) state.cookie=cookie.split(';')[0]
  const data=response.status===204?undefined:await response.json()
  assert(response.ok,`${method} ${path}: ${response.status} ${data?.error?.code??''}`)
  return data
}
export function control(state, value) {
  const expression=`fetch('http://127.0.0.1:3002/__control',${JSON.stringify(value===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)})}).then(r=>r.json()).then(v=>console.log(JSON.stringify(v)))`
  return JSON.parse(compose(state,['exec','-T','ai-worker','node','-e',expression]))
}
export function sql(state, query) {
  return compose(state,['exec','-T','postgres','psql','-X','-A','-t','-v','ON_ERROR_STOP=1','-U','v3_fixture','-d','dev_toolbox_v3_acceptance','-c',query])
}
export async function until(check, description, timeout=30000) {
  const end=Date.now()+timeout
  while(Date.now()<end){if(await check()) return;await new Promise(r=>setTimeout(r,150))}
  throw new Error(`Timed out: ${description}`)
}
const nginxStartupCodes=new Set(['ECONNRESET','ECONNREFUSED'])
export async function waitForNginx(endpoint, ca, timeout=5000) {
  const target=new URL(endpoint), deadline=Date.now()+timeout
  let lastCode
  while(Date.now()<deadline){
    const remaining=deadline-Date.now()
    // Per-attempt wall-clock bound: a socket-idle timeout never fires while a slow peer keeps trickling bytes.
    const code=await new Promise(resolve=>{
      const settle=value=>{clearTimeout(wallClock);resolve(value)}
      const request=httpsRequest(target,{path:'/',method:'GET',ca,agent:false},response=>{
        response.resume()
        settle(response.statusCode===200?null:`HTTP ${response.statusCode}`)
        request.destroy()
      })
      request.on('error',error=>settle(error.code??error.message))
      const wallClock=setTimeout(()=>request.destroy(Object.assign(new Error('request timed out'),{code:'ETIMEDOUT'})),remaining)
      request.end()
    })
    if(code===null) return
    lastCode=code
    if(code==='ETIMEDOUT') throw new Error(`Timed out: Nginx TLS at ${endpoint} not ready within ${timeout}ms (${lastCode})`)
    if(!nginxStartupCodes.has(code)) throw new Error(`Nginx TLS check failed at ${endpoint}: ${code}`)
    await new Promise(resolve=>setTimeout(resolve,Math.min(120,Math.max(deadline-Date.now(),0))))
  }
  throw new Error(`Timed out: Nginx TLS at ${endpoint} not ready within ${timeout}ms (${lastCode??'no response'})`)
}

async function up() {
  assert.equal(docker(['ps','-a','--filter',`label=com.docker.compose.project=${project}`,'-q']), '', 'fixture project already exists; inspect it before reusing')
  const directory=await mkdtemp(join(tmpdir(),'dev-toolbox-v3-acceptance-'))
  const fixturePassword=randomBytes(24).toString('base64url')
  await chmod(directory,0o700)
  for(const name of ['attachments','operations','postgres','caddy']) await mkdir(join(directory,name))
  await chmod(join(directory,'attachments'),0o777)
  for(const [name,value] of Object.entries({postgres_password:randomBytes(24).toString('hex'),internal_service_token:randomBytes(32).toString('hex'),agent_console_internal_token:randomBytes(32).toString('hex'),app_master_key:randomBytes(32).toString('base64'),owner_password:fixturePassword})) {
    await writeFile(join(directory,name),value,{mode:0o444})
  }
  const state={directory,origin:'http://localhost:18380'}
  await saveState(state)
  await writeFile(join(directory,'test.env'),'APP_DOMAIN=http://localhost\nAPP_ORIGIN=http://localhost:18380\nPOSTGRES_DB=dev_toolbox_v3_acceptance\nPOSTGRES_USER=v3_fixture\nALLOW_INSECURE_PROVIDER_HTTP=true\nAPP_VERSION=v3-local-acceptance\n')
  await writeFile(join(directory,'override.yaml'),`services:
  gateway:
    ports: !override ["127.0.0.1:18380:80"]
    volumes: !override ["${directory}/caddy:/data"]
    networks:
      frontend:
        aliases: [dev-toolbox-gateway]
  api:
    volumes: !override
      - ${directory}/attachments:/data
      - ${directory}/operations:/operations:ro
      - ${directory}:/fixture-state
      - ${root}/apps/api/bin/assistant-eval:/fixture/assistant-eval:ro
  ai-worker:
    command: ["sh", "-c", "node /fixture/mock-provider.mjs & exec node dist/index.js"]
    volumes: ["${root}/deploy/tests/v3/mock-provider.mjs:/fixture/mock-provider.mjs:ro"]
    networks: !override [backend]
  postgres:
    volumes: !override ["${directory}/postgres:/var/lib/postgresql"]
secrets:
  postgres_password:
    file: ${directory}/postgres_password
  internal_service_token:
    file: ${directory}/internal_service_token
  app_master_key:
    file: ${directory}/app_master_key
  agent_console_internal_token:
    file: ${directory}/agent_console_internal_token
`)
  console.log(`Fixture state: ${join(directory,'state.json')}`)
  for(const action of [['build'],['up','-d','--wait','--wait-timeout','120']]) {
    const result=spawnSync('docker',['--context','orbstack','compose','-p',project,'--env-file',join(directory,'test.env'),'-f',join(root,'deploy/compose.yaml'),'-f',join(directory,'override.yaml'),...action],{stdio:'inherit'})
    assert.equal(result.status,0,`compose ${action[0]} failed; fixture preserved at ${directory}`)
  }
  compose(state,['exec','-T','--user','root','api','/app/dev-toolbox','admin','init-owner','--password-file','/fixture-state/owner_password'])
  const challenge=await api(state,'/api/v1/auth/login',{username:'owner',password:fixturePassword})
  const setup=await api(state,'/api/v1/auth/totp/setup',{challengeId:challenge.challengeId})
  state.totpSecret=setup.manualKey
  const session=await api(state,'/api/v1/auth/totp/confirm',{challengeId:challenge.challengeId,code:totp(state.totpSecret),trustDevice:false,deviceName:''})
  state.csrf=session.csrfToken
  const provider=await api(state,'/api/v1/ai/providers',{providerKey:'v3-fixture',displayName:'V3 合成 Provider',protocol:'openai-completions',baseUrl:'http://ai-worker:3002/v1',apiKey:'synthetic-no-external-access',models:[{modelId:'fixture-chat',displayName:'验收模型',contextWindow:32768,maxOutputTokens:4096,supportsTools:false,supportsVision:false,reasoningOptions:[{displayName:'低',reasoning:'low',sortOrder:1}]}]})
  state.modelId=provider.models[0].id
  state.items=[]
  for(const [title,body] of [['织云巡检','织云验收节点每天 09:00 执行巡检。'],['青岚复核','青岚验收节点每周一进行复核。']]) {
    const note=await api(state,'/api/v1/items',{title,body,contentFormat:'plain_text',sensitivity:'normal',tagIds:[]})
    state.items.push(note.item.id)
  }
  await api(state,'/api/v1/assistant/embedding-settings',{displayName:'合成向量',baseUrl:'http://ai-worker:3002/v1',apiKey:'synthetic-embedding',modelId:'fixture-index',dimensions:3,enabled:true,confirmReindex:true},'PUT')
  await until(async()=> (await api(state,'/api/v1/assistant/index-status')).available===true,'initial index',60000)
  await saveState(state)
  console.log(`Four-container fixture ready: ${state.origin}/assistant`)
}

async function main(){
  const [command,path]=process.argv.slice(2)
  if(command==='up') return up()
  assert(path,'state.json path is required')
  const state=await loadState(path)
  if(command==='down') { compose(state,['down','--timeout','3']); console.log('Removed only the isolated V3 fixture containers/network; temporary files retained for inspection.');return }
  if(command==='eval') {
    const reportName=`evaluation-${Date.now()}.json`
    const input=JSON.parse(await readFile(join(root,'apps/api/cmd/assistant-eval/testdata/synthetic.json'),'utf8'))
    const rawIds=state.items.map(id=>sql(state,`SELECT id FROM search_fragments WHERE item_id='${id}' AND source_kind='raw_text' ORDER BY ordinal LIMIT 1`))
    const allowed=sql(state,`SELECT id FROM search_fragments WHERE item_id IN ('${state.items.join("','")}') AND active`).split('\n')
    for(const q of input.questions) {
      q.expectedFragmentIds=q.expectedFragmentIds.map(id=>id.endsWith('1')?rawIds[0]:rawIds[1])
      if(q.expected==='answer')q.allowedFragmentIds=allowed
    }
    await writeFile(join(state.directory,'cases.json'),JSON.stringify(input),{mode:0o600})
    const password=await readFile(join(state.directory,'owner_password'),'utf8')
    await writeFile(join(state.directory,'eval-auth.json'),JSON.stringify({username:'owner',password,totpCode:totp(state.totpSecret)}),{mode:0o600})
    await writeFile(join(state.directory,'schema.json'),await readFile(join(root,'docs/contracts/assistant-evaluation.schema.json')))
    console.log(`Private synthetic report: ${join(state.directory,reportName)}`)
    console.log(compose(state,['exec','-T','--user','root','api','/fixture/assistant-eval','run','--cases','/fixture-state/cases.json','--schema','/fixture-state/schema.json','--report',`/fixture-state/${reportName}`,'--auth-file','/fixture-state/eval-auth.json','--origin',state.origin,'--fixture-api','http://gateway','--model-id',state.modelId,'--allow-provider-calls']))
    return
  }
  throw new Error('Use up, eval STATE, or down STATE')
}
if(typeof process!=='undefined' && import.meta.url===pathToFileURL(process.argv[1]??'').href) main().catch(error=>{console.error(error.message);process.exitCode=1})
