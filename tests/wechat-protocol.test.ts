import {
  buildGetUpdatesPayload,
  buildGetTypingTicketPayload,
  buildHeaders,
  buildSendTextMessagePayload,
  buildSendTypingPayload,
  parseInboundMessage,
  parseQRCodeState,
  parseTypingTicket,
} from '../src/wechat/protocol.js'

describe('WeChat protocol pure functions', () => {
  it('builds authenticated headers without changing the token', () => {
    expect(buildHeaders('token', 'dWlu')).toEqual({
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      Authorization: 'Bearer token',
      'X-WECHAT-UIN': 'dWlu',
    })
  })

  it('maps QR status values and validates confirmed credentials', () => {
    expect(parseQRCodeState({ status: 'scaned' })).toEqual({ kind: 'scanned' })
    expect(parseQRCodeState({ status: 'confirmed', bot_token: 'b', ilink_bot_id: 'bot', ilink_user_id: 'user' })).toEqual({
      kind: 'confirmed', botToken: 'b', ilinkBotId: 'bot', ilinkUserId: 'user',
    })
    expect(() => parseQRCodeState({ status: 'confirmed' })).toThrow('missing session fields')
  })

  it('accepts only user text and maps context to a reply context', () => {
    expect(parseInboundMessage({ message_type: 2, from_user_id: 'user', item_list: [] })).toBeNull()
    expect(parseInboundMessage({
      message_type: 1,
      message_id: 'm-1',
      from_user_id: 'user-1',
      to_user_id: 'bot-1',
      context_token: 'ctx-1',
      item_list: [
        { type: 1, text_item: { text: 'hello' } },
        { type: 2, image_item: { url: 'ignored' } },
        { type: 1, text_item: { text: 'world' } },
      ],
    })).toEqual({
      platform: 'wechat-claw',
      accountId: 'bot-1',
      conversationId: 'user-1',
      senderId: 'user-1',
      messageId: 'm-1',
      text: 'hello\nworld',
      receivedAt: expect.any(Number),
      replyContext: { contextToken: 'ctx-1' },
      rawType: 'text',
    })
  })

  it('maps voice and file items to downloadable attachments', () => {
    const media = { encrypt_query_param: 'query', aes_key: Buffer.alloc(16, 7).toString('base64') }
    expect(parseInboundMessage({
      message_type: 1,
      message_id: 'audio-1',
      from_user_id: 'user-1',
      item_list: [{ type: 3, voice_item: { media, text: '语音转写' } }],
    })).toMatchObject({
      text: '语音转写',
      rawType: 'audio',
      attachments: [{ kind: 'audio', fileName: 'wechat-audio.silk', mimeType: 'audio/silk', transcript: '语音转写', remote: { encryptQueryParam: 'query', aesKey: media.aes_key } }],
    })
    expect(parseInboundMessage({
      message_type: 1,
      message_id: 'file-1',
      from_user_id: 'user-1',
      item_list: [{ type: 4, file_item: { file_name: 'report.pdf', len: '12', media } }],
    })).toMatchObject({
      text: '[微信文件：report.pdf]',
      rawType: 'file',
      attachments: [{ kind: 'file', fileName: 'report.pdf', mimeType: 'application/pdf', size: 12, remote: { encryptQueryParam: 'query', aesKey: media.aes_key } }],
    })
  })

  it('builds getupdates and sendmessage payloads', () => {
    expect(buildGetUpdatesPayload('cursor')).toEqual({
      get_updates_buf: 'cursor',
      base_info: { channel_version: '1.0.2' },
    })
    expect(buildSendTextMessagePayload({
      toUserId: 'user', clientId: 'client', contextToken: 'context', text: 'reply',
    })).toMatchObject({
      msg: {
        to_user_id: 'user', client_id: 'client', message_type: 2, message_state: 2,
        context_token: 'context', item_list: [{ type: 1, text_item: { text: 'reply' } }],
      },
    })
  })

  it('builds typing ticket and typing status payloads', () => {
    expect(buildGetTypingTicketPayload({ ilinkUserId: 'bot', contextToken: 'context' })).toEqual({
      ilink_user_id: 'bot', context_token: 'context', base_info: { channel_version: '1.0.2' },
    })
    expect(parseTypingTicket({ typing_ticket: 'ticket' })).toBe('ticket')
    expect(buildSendTypingPayload({ ilinkUserId: 'user', typingTicket: 'ticket', status: 1 })).toMatchObject({
      ilink_user_id: 'user', typing_ticket: 'ticket', status: 1,
    })
    expect(buildSendTypingPayload({ ilinkUserId: 'user', typingTicket: 'ticket', status: 2 })).toMatchObject({ status: 2 })
  })
})
