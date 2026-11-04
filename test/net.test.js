import test from 'node:test';
import assert from 'node:assert/strict';

// Minimal browser WebSocket stand-in so net.js can run under Node.
class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = FakeSocket.CONNECTING;
    this.listeners = {};
    FakeSocket.instances.push(this);
  }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  emit(type, event = {}) { for (const fn of this.listeners[type] ?? []) fn(event); }
  send() {}
  close() { this.readyState = 3; }
}
globalThis.WebSocket = FakeSocket;

const net = await import('../js/net.js');

test('a stale socket closing after a reconnect does not dispatch or reconnect', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const disconnects = [];
  net.on('_disconnected', () => disconnects.push(Date.now()));

  net.connect('ws://test');
  const first = FakeSocket.instances.at(-1);
  net.disconnect();
  net.connect('ws://test');
  const second = FakeSocket.instances.at(-1);

  first.emit('close');          // the old socket's close arrives late
  t.mock.timers.tick(20_000);   // let any scheduled reconnect fire

  assert.deepEqual(disconnects, []);
  assert.equal(FakeSocket.instances.at(-1), second, 'no extra socket was opened');
  net.disconnect();
});

test('disconnect cancels a pending reconnect', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  net.on('_disconnected', () => {});
  net.connect('ws://test');
  const socket = FakeSocket.instances.at(-1);
  socket.emit('close');         // unexpected drop → reconnect scheduled
  net.disconnect();
  const count = FakeSocket.instances.length;
  net.connect('ws://test');     // user starts over before the timer fires
  t.mock.timers.tick(20_000);
  assert.equal(FakeSocket.instances.length, count + 1, 'only the new connect opened a socket');
  net.disconnect();
});
