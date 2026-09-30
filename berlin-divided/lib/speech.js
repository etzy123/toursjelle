// Microsoft Edge's read-aloud voices, the same ones scripts/build_tour.py uses through edge-tts,
// for tours made on the spot. This follows the edge-tts protocol (github.com/rany2/edge-tts):
// one WebSocket per clip, a speech.config message, the SSML, then binary audio frames until turn.end.
'use strict';
const crypto = require('node:crypto');
const WebSocket = require('ws');

const TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM = '143.0.3650.75', MAJOR = CHROMIUM.split('.')[0];
const WSS = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TOKEN}`;
const HEADERS = {
  'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${MAJOR}.0.0.0 Safari/537.36 Edg/${MAJOR}.0.0.0`,
  'Accept-Encoding': 'gzip, deflate, br, zstd', 'Accept-Language': 'en-US,en;q=0.9',
  Pragma: 'no-cache', 'Cache-Control': 'no-cache', Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
};
const VOICES = { en: 'en-GB-RyanNeural', nl: 'nl-NL-MaartenNeural', de: 'de-DE-ConradNeural' };
const BYTES_PER_SECOND = 48000 / 8; // audio-24khz-48kbitrate-mono-mp3 is constant bitrate

// Sec-MS-GEC: SHA-256 of the Windows file time, rounded down to 5 minutes, and the client token
function secMsGec(now = Date.now()) {
  let s = Math.floor(now / 1000) + 11644473600;
  s -= s % 300;
  return crypto.createHash('sha256').update(`${BigInt(s) * 10000000n}${TOKEN}`).digest('hex').toUpperCase();
}
const jsDate = () => new Date().toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) (.+) GMT$/, '$1 $3 $2 $4 $5 GMT+0000 (Coordinated Universal Time)');
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// one clip: resolves with an MP3 buffer
function speak(text, { voice = VOICES.en, rate = '-4%', timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const id = () => crypto.randomUUID().replace(/-/g, '');
    const ws = new WebSocket(`${WSS}&ConnectionId=${id()}&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=1-${CHROMIUM}`,
      { headers: { ...HEADERS, Cookie: `muid=${crypto.randomBytes(16).toString('hex').toUpperCase()};` }, perMessageDeflate: true });
    const chunks = []; let done = false;
    const finish = err => { if (done) return; done = true; clearTimeout(timer); try { ws.close(); } catch (e) {} err ? reject(err) : resolve(Buffer.concat(chunks)); };
    const timer = setTimeout(() => finish(new Error('speech: timed out')), timeout);
    ws.on('open', () => {
      ws.send(`X-Timestamp:${jsDate()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n`
        + '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n');
      ws.send(`X-RequestId:${id()}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${jsDate()}Z\r\nPath:ssml\r\n\r\n`
        + `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='${voice}'><prosody pitch='+0Hz' rate='${rate}' volume='+0%'>${esc(text)}</prosody></voice></speak>`);
    });
    ws.on('message', (data, binary) => {
      if (!binary) { if (String(data).includes('Path:turn.end')) finish(chunks.length ? null : new Error('speech: no audio')); return; }
      const head = data.readUInt16BE(0), headers = data.subarray(2, 2 + head).toString();
      if (headers.includes('Path:audio') && data.length > head + 2) chunks.push(data.subarray(2 + head));
    });
    ws.on('unexpected-response', (req, res) => finish(new Error(`speech: ${res.statusCode}`)));
    ws.on('error', e => finish(new Error(`speech: ${e.message}`)));
    ws.on('close', () => finish(chunks.length ? null : new Error('speech: closed without audio')));
  });
}

const seconds = buf => Math.round((buf.length / BYTES_PER_SECOND) * 10) / 10;

module.exports = { speak, seconds, secMsGec, VOICES };
