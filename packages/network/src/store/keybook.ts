import { Datastore, Key } from 'interface-datastore'
import { NamespaceDatastore } from 'datastore-core'
import { Closer, ThreadID, LogID } from '@textile/threads-core'
import { keys, PrivateKey, PublicKey } from '@textile/threads-crypto'
import PeerId from 'peer-id'

/**
 * Public and private keys are stored under the following db key pattern:
 *    /threads/keys/<b32 thread id no padding>/<b32 log id no padding>:(pub|priv)
 * Follow and read keys are stored under the following db key pattern:
 *    /threads/keys/<b32 thread id no padding>:(repl|read)
 */
const baseKey = new Key('/thread/keys')
const getKey = (id: ThreadID, log: LogID, suffix?: string) => {
  const idString = log.toB58String()
  return new Key(id.toString()).child(new Key(suffix ? `${idString}:${suffix}` : idString))
}

/**
 * KeyBook stores Thread/Log keys.
 */
export class KeyBook implements Closer {
  constructor(private datastore: Datastore<Buffer>) {
    this.datastore = new NamespaceDatastore(datastore, baseKey)
  }

  /**
   * pubKey retrieves the public key of a log.
   * @param id The Thread ID.
   * @param log The Log ID.
   */
  async pubKey(id: ThreadID, log: LogID) {
    try {
      const key = await this.datastore.get(getKey(id, log, 'pub'))
      return keys.unmarshalPublicKey(key) as PublicKey
    } catch (err) {
      return
    }
  }

  /**
   * addPubKey adds a public key under a log.
   * @param id The Thread ID.
   * @param log The Log ID.
   * @param pubKey The public key from a symmetric key pair.
   */
  async addPubKey(id: ThreadID, log: LogID, pubKey: PublicKey) {
    const key = Buffer.from(pubKey.bytes)
    if (!log.equals(await PeerId.createFromPubKey(key))) {
      throw new Error('Public Key Mismatch')
    }
    return this.datastore.put(getKey(id, log, 'pub'), key)
  }

  /**
   * privKey retrieves the private key of a log.
   * @param id The Thread ID.
   * @param log The Log ID.
   */
  async privKey(id: ThreadID, log: LogID) {
    try {
      const key = await this.datastore.get(getKey(id, log, 'priv'))
      return keys.unmarshalPrivateKey(key)
    } catch (err) {
      return
    }
  }

  /**
   * addPrivKey adds a private key under a log.
   * @param id The Thread ID.
   * @param log The Log ID.
   * @param privKey The private key from a symmetric key pair.
   */
  async addPrivKey(id: ThreadID, log: LogID, privKey: PrivateKey) {
    const key = Buffer.from(privKey.bytes)
    const check = await PeerId.createFromPrivKey(key)
    if (!log.equals(check)) {
      throw new Error('Private Key Mismatch')
    }
    return this.datastore.put(getKey(id, log, 'priv'), key)
  }

  /**
   * readKey retrieves the read key of a log.
   * @param id The Thread ID.
   */
  async readKey(id: ThreadID) {
    try {
      return await this.datastore.get(new Key(id.toString()).child(new Key('read')))
    } catch (err) {
      return
    }
  }

  /**
   * addReadKey adds a read key under a thread.
   * @param id The Thread ID.
   * @param key The asymmetric read key, of length 44 bytes.
   */
  addReadKey(id: ThreadID, key: Uint8Array) {
    return this.datastore.put(new Key(id.toString()).child(new Key('read')), Buffer.from(key))
  }

  /**
   * serviceKey retrieves the replicator key of a thread.
   */
  async serviceKey(id: ThreadID) {
    try {
      return await this.datastore.get(new Key(id.toString()).child(new Key('repl')))
    } catch (err) {
      return
    }
  }

  /**
   * addServiceKey adds a replicator key under a given thread.
   * @param id The Thread ID.
   * @param key The asymmetric replicator key, of length 44 bytes.
   */
  addServiceKey(id: ThreadID, key: Uint8Array) {
    return this.datastore.put(new Key(id.toString()).child(new Key('repl')), Buffer.from(key))
  }

  async threads() {
    const threads = new Set<ThreadID>()
    for await (const { key } of this.datastore.query({
      prefix: baseKey.toString(),
      keysOnly: true,
    })) {
      // We only care about threads we can replicate
      if (key.name() === 'repl') {
        threads.add(ThreadID.fromString(key.parent().toString()))
      }
    }
    return threads
  }

  async logs(id: ThreadID): Promise<Set<LogID>> {
    const logs = new Set<LogID>()
    const q = { keysOnly: true, prefix: id.toString() }
    for await (const { key } of this.datastore.query(q)) {
      if (['priv', 'pub'].includes(key.name())) {
        const log = PeerId.createFromB58String(key.type())
        logs.add(log)
      }
    }
    return logs
  }

  /**
   * clearThreadKeys deletes all keys under a given thread.
   * @param id Thread ID.
   */
  async clearThreadKeys(id: ThreadID) {
    const batch = this.datastore.batch()
    for await (const { key } of this.datastore.query({
      prefix: baseKey.child(new Key(id.toString())).toString(),
      keysOnly: true,
    })) {
      batch.delete(key)
    }
    return batch.commit()
  }

  /**
   * clearLogKeys deletes all keys under a given log.
   * @param id Thread ID.
   * @param log: Log ID.
   */
  async clearLogKeys(id: ThreadID, log: LogID) {
    const batch = this.datastore.batch()
    for await (const { key } of this.datastore.query({
      prefix: getKey(id, log).toString(),
      keysOnly: true,
    })) {
      batch.delete(key)
    }
    return batch.commit()
  }

  close() {
    return this.datastore.close()
  }
}
