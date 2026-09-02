import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { api, control, docker, loadState, saveState, sql, until } from './stack.mjs'

const state=await loadState(process.argv[2])
const groups=new Set((process.argv[3]??'caddy,flows,lanes,nginx').split(','))
assert([...groups].every(group=>['caddy','flows','lanes','nginx'].includes(group)),'Unknown check group')
const checks=[]
const pass=(name,detail={})=>{checks.push({name,...detail});console.log(`PASS ${name}`)}
const start=content=>api(state,'/api/v1/assistant/runs',{clientRequestId:randomUUID(),conversationId:null,folderId:null,content,modelId:state.modelId,reasoning:'low'})
async function finished(id) {
  let run
  await until(async()=>{run=await api(state,`/api/v1/assistant/runs/${id}`);return ['succeeded','failed','stopped'].includes(run.status)},'run terminal',30000)
  return run
}
async function stream(path,body,endpoint=state.origin,ca) {
  const target=new URL(endpoint+path)
  return new Promise((resolveStream,reject)=>{
    const request=(target.protocol==='https:'?httpsRequest:httpRequest)(target,{
      method:body===undefined?'GET':'POST',ca,headers:{Origin:state.origin,Cookie:state.cookie,'X-CSRF-Token':state.csrf,'Content-Type':'application/json'},
    },response=>{
      if(response.statusCode!==200){response.resume();reject(new Error(`SSE HTTP ${response.statusCode}`));return}
      resolveStream({request,response,events:events(response),close(){response.destroy();request.destroy()}})
    })
    request.on('error',reject)
    request.setTimeout(30000,()=>request.destroy(new Error('SSE timeout')))
    request.end(body===undefined?undefined:JSON.stringify(body))
  })
}
async function* events(response){
  let buffer=''
  response.setEncoding('utf8')
  for await(const chunk of response){
    buffer+=chunk
    let end
    while((end=buffer.indexOf('\n\n'))>=0){
      const block=buffer.slice(0,end);buffer=buffer.slice(end+2)
      const lines=block.split('\n'),name=lines.find(l=>l.startsWith('event: '))?.slice(7),data=lines.find(l=>l.startsWith('data: '))?.slice(6)
      if(name&&data)yield {name,data:JSON.parse(data),id:lines.find(l=>l.startsWith('id: '))?.slice(4)}
    }
  }
}
async function first(iterator){
  let timer
  try{return await Promise.race([iterator.next(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('first SSE event buffered')),2000)})])}
  finally{clearTimeout(timer)}
}
async function proxyChecks(label,endpoint,ca){
  control(state,{holdAnswers:true})
  const started=await start('织云节点的巡检约定是什么？')
  const begin=Date.now(),s=await stream(`/api/v1/assistant/runs/${started.run.id}/events`,undefined,endpoint,ca)
  const initial=await first(s.events)
  assert.equal(initial.value.name,'snapshot')
  assert.equal(initial.value.id,undefined,'snapshot must not replace reconnect event ID')
  const firstEventMs=Date.now()-begin
  s.close()
  await until(()=> (control(state).active.answer??0)>0,'provider started')
  assert.equal((await api(state,`/api/v1/assistant/runs/${started.run.id}`)).status,'running')
  control(state,{holdAnswers:false})
  assert.equal((await finished(started.run.id)).status,'succeeded')
  pass(`${label}: first event / persistent disconnect`,{firstEventMs})

  const before=sql(state,'SELECT (SELECT count(*) FROM assistant_conversations)||\',\'||(SELECT count(*) FROM assistant_messages)||\',\'||(SELECT count(*) FROM assistant_runs)||\',\'||(SELECT count(*) FROM assistant_run_sources)')
  const previousAborts=control(state).aborted.answer??0
  control(state,{holdAnswers:true})
  const temporary=await stream('/api/v1/assistant/temporary/stream',{clientRequestId:randomUUID(),modelId:state.modelId,reasoning:'off',messages:[],summary:null,content:'织云节点临时巡检'},endpoint,ca)
  const temporaryInitial=(await first(temporary.events)).value
  assert.equal(temporaryInitial.name,'run.status')
  assert.equal(temporaryInitial.data.sequence,1)
  await until(()=> (control(state).active.answer??0)>0,'temporary provider started')
  temporary.close()
  await until(()=> (control(state).aborted.answer??0)>previousAborts,'temporary AbortSignal reached provider')
  control(state,{holdAnswers:false})
  const after=sql(state,'SELECT (SELECT count(*) FROM assistant_conversations)||\',\'||(SELECT count(*) FROM assistant_messages)||\',\'||(SELECT count(*) FROM assistant_runs)||\',\'||(SELECT count(*) FROM assistant_run_sources)')
  assert.equal(after,before,'temporary request persisted conversation content')
  pass(`${label}: temporary disconnect / no content persistence`)
  return started
}

async function verify(){
  if(groups.has('caddy')) {
    const startResult=await proxyChecks('Caddy',state.origin)
    state.browserConversationId=startResult.conversation.id
    await saveState(state)
    const messages=await api(state,`/api/v1/assistant/conversations/${startResult.conversation.id}/messages`)
    const answer=messages.items.find(m=>m.id===startResult.assistantMessage.id)
    assert(answer.citations.length>0)
    assert(answer.reasoningContent.length>0)
    for(const citation of answer.citations){
      const source=await api(state,`/api/v1/assistant/runs/${startResult.run.id}/sources/${citation.citationNumber}`)
      assert(source.locator?.fragmentId)
      assert(source.excerpt)
  }
  pass('Worker → Go → public canonical citation/source/reasoning')
  }

  if(groups.has('flows')) {
    // The contract permits one same-model retry before the first visible delta.
    control(state,{failAnswers:2})
    const failure=await start('织云失败重试验收')
    const failed=await finished(failure.run.id)
    assert.equal(failed.status,'failed');assert.equal(failed.canRetry,true)
    const retried=await api(state,`/api/v1/assistant/runs/${failed.id}/retry`,{clientRequestId:randomUUID(),modelId:state.modelId,reasoning:'off'})
    assert.equal((await finished(retried.run.id)).status,'succeeded')
    pass('failed run / explicit retry')

    control(state,{holdAnswers:true})
    const stopping=await start('织云停止验收')
    await until(()=> (control(state).active.answer??0)>0,'stoppable provider started')
    await api(state,`/api/v1/assistant/runs/${stopping.run.id}/stop`,{})
    assert.equal((await finished(stopping.run.id)).status,'stopped')
    control(state,{holdAnswers:false})
    pass('persistent stop reaches provider and terminal state')

    const config=await api(state,'/api/v1/assistant/embedding-settings')
    const updateEmbedding=enabled=>api(state,'/api/v1/assistant/embedding-settings',{displayName:config.displayName,baseUrl:config.baseUrl,modelId:config.modelId,dimensions:config.dimensions,enabled,confirmReindex:true},'PUT')
    await updateEmbedding(false)
    const countBefore=control(state).started.index??0
    const unavailable=await stream('/api/v1/assistant/temporary/stream',{clientRequestId:randomUUID(),modelId:state.modelId,reasoning:'off',messages:[],summary:null,content:'只根据笔记回答织云巡检约定'})
    let unavailableText='',unavailableState
    for await(const event of unavailable.events){
      if(event.name==='answer.delta')unavailableText+=event.data.delta
      if(event.name==='sources.ready')unavailableState=event.data.evidenceState
  }
  assert.equal(unavailableState,'unavailable')
  assert(unavailableText.includes('知识库当前不可用'))
  assert(!unavailableText.includes('当前知识库未找到足够依据'))
  assert.equal(control(state).started.index??0,countBefore,'unavailable must skip embedding')
  await updateEmbedding(true)
  await until(async()=> (await api(state,'/api/v1/assistant/index-status')).available,'reindex',60000)
  pass('unavailable skips retrieval and is distinct from not_found')
  }

  if(groups.has('lanes')) {
    control(state,{holdAnswers:true})
    const one=await start('织云并行会话一'),two=await start('织云并行会话二')
    await until(()=> (control(state).active.answer??0)===2,'two chat slots')
    control(state,{holdIndex:true})
    const indexed=await api(state,'/api/v1/items',{title:'额外巡检合成记录',body:'织云节点新的合成巡检记录。',contentFormat:'plain_text',sensitivity:'normal',tagIds:[]})
    await until(()=> (control(state).active.index??0)>0,'index slot independently started')
    const task=await api(state,'/api/v1/ai/tasks',{taskType:'organize_record',itemId:indexed.item.id,modelId:state.modelId,sensitivePolicy:'block',options:{includeRelatedRecords:false}})
    await until(()=> (control(state).started.task??0)>0,'AI Task lane while chats/index are busy')
    control(state,{holdAnswers:false,holdIndex:false})
    assert.equal((await finished(one.run.id)).status,'succeeded')
    assert.equal((await finished(two.run.id)).status,'succeeded')
    let taskState
    await until(async()=>{taskState=await api(state,`/api/v1/ai/tasks/${task.id}`);return ['succeeded','failed','cancelled'].includes(taskState.status)},'AI Task completion',30000)
    assert.equal(taskState.status,'succeeded')
    await until(async()=> (await api(state,'/api/v1/assistant/index-status')).available,'index after task',60000)
    pass('two chat slots + independent index lane + existing AI Task lane')
    // Keep the fixed evaluation source pool unchanged; this fixture remains recoverable in trash.
    await api(state,`/api/v1/items/${indexed.item.id}`,undefined,'DELETE')
  }

  if(groups.has('nginx')) {
    // Exercise the actual supported external-Nginx template with an ephemeral TLS fixture.
    const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..')
    const nginxDirectory=join(state.directory,'nginx')
    await mkdir(nginxDirectory,{recursive:true})
    const openssl=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(nginxDirectory,'localhost.key'),'-out',join(nginxDirectory,'localhost.pem'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],{encoding:'utf8'})
    assert.equal(openssl.status,0,'test certificate generation')
    const template=await readFile(join(root,'deploy/nginx/external-nginx.conf.template'),'utf8')
    await writeFile(join(nginxDirectory,'default.conf'),template.replaceAll('__APP_DOMAIN__','localhost'))
    const name='dev-toolbox-v3-acceptance-nginx'
    assert.equal(docker(['ps','-a','--filter',`name=^/${name}$`,'-q']),'','nginx fixture already exists')
    docker(['run','-d','--name',name,'--network','dev-toolbox-v3-acceptance_frontend','-p','127.0.0.1:18443:443','-v',`${nginxDirectory}/default.conf:/etc/nginx/conf.d/default.conf:ro`,'-v',`${nginxDirectory}:/etc/nginx/cert:ro`,'nginx:stable-alpine'])
    try{
      docker(['exec',name,'nginx','-t'])
      const ca=await readFile(join(nginxDirectory,'localhost.pem'))
      await proxyChecks('external Nginx → Caddy','https://localhost:18443',ca)
    } finally { docker(['rm','-f',name]) }
  }
  await writeFile(join(state.directory,`checks-${[...groups].join('-')}.json`),JSON.stringify(checks,null,2),{mode:0o600})
  console.log('V3 four-container mock checks complete; no real Provider calls.')
}
verify().catch(error=>{control(state,{holdAnswers:false,holdIndex:false,failAnswers:0});console.error(error.message);process.exitCode=1})
