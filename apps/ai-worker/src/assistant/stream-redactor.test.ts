import { describe, expect, it } from 'vitest'

import { StreamRedactor } from './stream-redactor.js'

function runAll(text: string, partitions: number[][]): string[] {
  return partitions.map((cuts) => {
    const redactor = new StreamRedactor()
    let position = 0
    let output = ''
    for (const cut of [...cuts, text.length]) {
      output += redactor.push(text.slice(position, cut))
      position = cut
    }
    output += redactor.flush()
    return output
  })
}

// Every single split point plus chunked partitions must agree with the
// one-shot result (docs/16 §6.2 partition invariance).
function partitionsFor(text: string): number[][] {
  const partitions: number[][] = [[]]
  for (let index = 1; index < text.length; index++) {
    partitions.push([index])
  }
  if (text.length > 4) {
    partitions.push([2, 5, 9])
    partitions.push([1, 3, 7, 11])
  }
  return partitions
}

const fixtures = [
  '正常回答，没有任何敏感内容。',
  '密码是 password=hunter2 请不要外传',
  'api_key: sk-abcdef123456 和 username=admin',
  'Bearer abcdefgh123456789 后面是普通文本',
  '内网地址 10.1.2.3 与 192.168.1.1 和 172.16.0.9',
  '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADAN\n-----END PRIVATE KEY-----\n结束',
  '多行:\ntoken = "abc,def;ghi" 结束',
  'short Bearer abc 不满八位',
  'my_db_password: p@ss,word 后文',
]

describe('StreamRedactor', () => {
  it('produces identical output for any chunk partition', () => {
    for (const fixture of fixtures) {
      const results = runAll(fixture, partitionsFor(fixture))
      const reference = results[0]
      for (const result of results) {
        expect(result).toBe(reference)
      }
    }
  })

  it('redacts credential values with category placeholders', () => {
    const output = runAll('password=hunter2 结束', [[]])[0]!
    expect(output).toContain('<PASSWORD_1>')
    expect(output).not.toContain('hunter2')
  })

  it('redacts bearer tokens', () => {
    const output = runAll('Bearer abcdefgh123456789 ok', [[]])[0]!
    expect(output).toContain('Bearer <TOKEN_1>')
    expect(output).not.toContain('abcdefgh123456789')
  })

  it('redacts private keys across partitions', () => {
    const key = '-----BEGIN PRIVATE KEY-----\nMIIEvQ\n-----END PRIVATE KEY-----'
    const outputs = runAll('前 ' + key + ' 后', partitionsFor('前 ' + key + ' 后'))
    for (const output of outputs) {
      expect(output).toContain('<PRIVATE_KEY_1>')
      expect(output).not.toContain('MIIEvQ')
    }
  })

  it('never leaks an open value in any emitted prefix', () => {
    const text = 'api_key=supersecretvalue123 trailing'
    const redactor = new StreamRedactor()
    let output = ''
    for (const character of text) {
      output += redactor.push(character)
      // No emitted prefix may contain any part of the secret value.
      expect(output).not.toContain('supersecret')
    }
    output += redactor.flush()
    expect(output).toContain('<API_KEY_1>')
    expect(output).not.toContain('supersecretvalue123')
  })

  it('redacts private IPv4 addresses', () => {
    const output = runAll('服务器 10.255.0.4 已下线', [[]])[0]!
    expect(output).toContain('<INTERNAL_IP_1>')
    expect(output).not.toContain('10.255.0.4')
  })

  it('leaves ordinary text untouched', () => {
    const output = runAll('这是普通回答，含标点、数字 12345 与英文 words。', [[]])[0]!
    expect(output).toBe('这是普通回答，含标点、数字 12345 与英文 words。')
  })
})
