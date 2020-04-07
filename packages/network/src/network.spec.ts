/* eslint-disable import/first */
// Some hackery to get WebSocket in the global namespace on nodejs
;(global as any).WebSocket = require('isomorphic-ws')

import { randomBytes } from 'libp2p-crypto'
import { expect } from 'chai'
import PeerId from 'peer-id'
import { keys } from 'libp2p-crypto'
import {
  ThreadID,
  ThreadInfo,
  Block,
  ThreadRecord,
  Multiaddr,
  ThreadKey, ThreadToken,
} from '@textile/threads-core'
import { createEvent, createRecord } from '@textile/threads-encoding'
import { Client } from '@textile/threads-network-client'
import { MemoryDatastore } from 'interface-datastore'
import { Network } from '.'

const proxyAddr1 = 'http://127.0.0.1:6007'
const proxyAddr2 = 'http://127.0.0.1:6207'
const ed25519 = keys.supportedKeys.ed25519

async function createThread(client: Network) {
  const id = ThreadID.fromRandom(ThreadID.Variant.Raw, 32)
  const threadKey = ThreadKey.fromRandom()
  return client.createThread(id, { threadKey })
}

function threadAddr(hostAddr: Multiaddr, hostID: PeerId, info: ThreadInfo) {
  const pa = new Multiaddr(`/p2p/${hostID.toB58String()}`)
  const ta = new Multiaddr(`/thread/${info.id.toString()}`)
  return hostAddr.encapsulate(pa.encapsulate(ta)) as any
}

describe('Network...', () => {
  let client: Network
  before(async () => {
    const identity = await ed25519.generateKeyPair()
    client = new Network(new MemoryDatastore(), new Client({ host: proxyAddr1 }), identity)
    const token = await client.getToken(identity)
    expect(token).to.not.be.undefined
  })
  describe('Basic...', () => {
    it('should return a remote host peer id', async () => {
      const id = await client.getHostID()
      expect(PeerId.isPeerId(id)).to.be.true
    })

    it('should create a remote thread', async () => {
      const id = ThreadID.fromRandom(ThreadID.Variant.Raw, 32)
      const threadKey = ThreadKey.fromRandom()
      const info = await client.createThread(id, { threadKey })
      expect(info.id.toString()).to.equal(id.toString())
      expect(info.key?.read).to.not.be.undefined
      expect(info.key?.service).to.not.be.undefined
    })

    it('should add a remote thread', async () => {
      const hostID = await client.getHostID()
      const info1 = await createThread(client)
      const hostAddr = new Multiaddr('/dns4/threads1/tcp/4006')
      const addr = threadAddr(hostAddr, hostID, info1)
      const client2 = new Client({ host: proxyAddr2 })
      // Create temporary identity
      const identity = await ed25519.generateKeyPair()
      const token2 = await client2.getToken(identity)
      const info2 = await client2.addThread(addr, { threadKey: info1.key, token: token2 })
      expect(info2.id.toString()).to.equal(info1.id.toString())
    })

    it('should add and then get a remote thread', async () => {
      const info1 = await createThread(client)
      const info2 = await client.getThread(info1.id)
      expect(info2.id.toString()).to.equal(info1.id.toString())
    })

    it('should pull a thread for records', async () => {
      const info = await createThread(client)
      try {
        await client.pullThread(info.id)
      } catch (err) {
        throw new Error(`unexpected error: ${err}`)
      }
    })

    it('should delete an existing thread', async () => {
      const info = await createThread(client)
      const info2 = await client.getThread(info.id)
      expect(info2.id.toString()).to.equal(info.id.toString())
      try {
        await client.deleteThread(info.id)
      } catch (err) {
        throw new Error(`unexpected error: ${err}`)
      }
      try {
        await client.getThread(info.id)
        throw new Error('should not have throw')
      } catch (err) {
        expect(err.toString()).to.equal('Error: thread not found')
      }
    })

    it('should add a replicator to a thread', async () => {
      const client2 = new Client({ host: proxyAddr2 })
      const hostID2 = await client2.getHostID()
      const hostAddr2 = new Multiaddr(`/dns4/threads2/tcp/4006`)

      const info1 = await createThread(client)

      const peerAddr = hostAddr2.encapsulate(new Multiaddr(`/p2p/${hostID2}`))

      const pid = await client.addReplicator(info1.id, peerAddr)
      expect(pid.toB58String()).to.equal(hostID2.toB58String())
    })

    it('should create a new record', async () => {
      const info = await createThread(client)
      const body = { foo: 'bar', baz: Buffer.from('howdy') }
      const rec = await client.createRecord(info.id, body)
      expect(rec?.threadID.toString()).to.equal(info.id.toString())
      expect(rec?.logID).to.not.be.undefined
      if (rec?.record) {
        const block = rec.record.block
        expect(block).to.have.ownProperty('body')
      } else {
        throw new Error('expected record to be defined')
      }
    })

    it('should be able to add a pre-formed record', async () => {
      // Create a thread, keeping read key and log private key on the client
      const id = ThreadID.fromRandom(ThreadID.Variant.Raw, 32)
      const threadKey = ThreadKey.fromRandom(false)
      const privKey = await ed25519.generateKeyPair()
      const logKey = privKey.public
      const info = await client.createThread(id, { threadKey, logKey })

      const body = { foo: 'bar', baz: Buffer.from('howdy') }
      const readKey = randomBytes(32)
      const block = Block.encoder(body, 'dag-cbor')
      const event = await createEvent(block, readKey)
      // Re-use log key for pub key
      const record = await createRecord(event, {
        privKey,
        servKey: threadKey.service,
        pubKey: logKey,
      })
      const cid1 = await record.value.cid()
      const logID = await PeerId.createFromPubKey(privKey.public.bytes)
      await client.addRecord(info.id, logID, record)
      const record2 = await client.getRecord(info.id, cid1)
      if (!record2) {
        throw new Error('expected record to be defined')
      }
      const cid2 = await record2.value.cid()
      expect(cid1.toString()).to.equal(cid2.toString())
      const b1 = await record.block.value.cid()
      const b2 = await record2.block.value.cid()
      expect(b1.toString()).to.equal(b2.toString())
    })

    it('should be able to retrieve a remote record', async () => {
      const info = await createThread(client)
      const body = { foo: 'bar', baz: Buffer.from('howdy') }
      const rec1 = await client.createRecord(info.id, body)
      const cid1 = await rec1?.record?.value.cid()
      if (!cid1) throw new Error('expected valid record')
      const rec2 = await client.getRecord(info.id, cid1)
      const cid2 = await rec2.value.cid()
      expect(cid1.toString()).to.equal(cid2.toString())
    })

    describe('subscribe', () => {
      let client2: Network
      let info: ThreadInfo
      let token2: ThreadToken

      before(async () => {
        client2 = new Network(new MemoryDatastore(), new Client({ host: proxyAddr2 }))
        const hostID2 = await client2.getHostID()
        const hostAddr2 = new Multiaddr(`/dns4/threads2/tcp/4006`)
        const peerAddr = hostAddr2.encapsulate(new Multiaddr(`/p2p/${hostID2}`))
        info = await createThread(client)
        await client.addReplicator(info.id, peerAddr)
        // Create temporary identity
        const identity = await ed25519.generateKeyPair()
        token2 = await client2.getToken(identity)
      })

      it('should handle updates and close cleanly', done => {
        let rcount = 0
        const res = client2.subscribe(
          (rec?: ThreadRecord, err?: Error) => {
            expect(rec).to.not.be.undefined
            if (rec) rcount += 1
            if (err) throw new Error(`unexpected error: ${err.toString()}`)
            if (rcount >= 2) {
              res.close()
              done()
            }
          },
          [info.id],
          { token: token2 },
        )
        client.createRecord(info.id, { foo: 'bar1' }).then(() => {
          client.createRecord(info.id, { foo: 'bar2' })
        })
      }).timeout(10000)
    })
  })
})
