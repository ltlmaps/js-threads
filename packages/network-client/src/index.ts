import { grpc } from '@improbable-eng/grpc-web'
import CID from 'cids'
import PeerId from 'peer-id'
import { keys } from 'libp2p-crypto'
import log from 'loglevel'
import {
  ThreadID,
  LogID,
  ThreadInfo,
  NewThreadOptions,
  LogInfo,
  Block,
  ThreadRecord,
  LogRecord,
  Network,
  marshalKey,
  Multiaddr,
  ThreadKey,
  Identity,
  Libp2pCryptoIdentity,
} from '@textile/threads-core'
import { ContextInterface, ContextKeys, Context } from '@textile/context'
import * as pb from '@textile/threads-net-grpc/threadsnet_pb'
import { API, APIGetToken } from '@textile/threads-net-grpc/threadsnet_pb_service'
import { recordFromProto, recordToProto } from '@textile/threads-encoding'
import nextTick from 'next-tick'

const logger = log.getLogger('network-client')

function getThreadKeys(opts: NewThreadOptions) {
  const threadKeys = new pb.Keys()
  opts.threadKey && threadKeys.setThreadkey(opts.threadKey.toBytes())
  opts.logKey && threadKeys.setLogkey(marshalKey(opts.logKey))
  return threadKeys
}

function threadRecordFromProto(proto: pb.NewRecordReply.AsObject, key: ThreadKey) {
  const threadID = ThreadID.fromBytes(Buffer.from(proto.threadid as string, 'base64'))
  const rawID = Buffer.from(proto.logid as string, 'base64')
  const logID = PeerId.createFromBytes(rawID)
  const record = proto.record && recordFromProto(proto.record, key.service)
  const info: ThreadRecord = {
    record,
    threadID,
    logID,
  }
  return info
}

async function threadInfoFromProto(proto: pb.ThreadInfoReply.AsObject): Promise<ThreadInfo> {
  const id = ThreadID.fromBytes(Buffer.from(proto.threadid as string, 'base64'))
  const threadKey = Buffer.from(proto.threadkey as string, 'base64')
  const key = ThreadKey.fromBytes(threadKey)
  const logs: Set<LogInfo> = new Set()
  for (const log of proto.logsList) {
    const rawId = Buffer.from(log.id as string, 'base64')
    const pid = PeerId.createFromBytes(rawId)
    // @todo: Currently it looks like private key unmarshaling isn't compatible between Go and JS?
    // const pkBytes = Buffer.from(log.privkey as string)
    // const privKey = await keys.unmarshalPrivateKey(pkBytes)
    const logInfo: LogInfo = {
      id: pid,
      addrs: new Set(
        log.addrsList.map((addr) => new Multiaddr(Buffer.from(addr as string, 'base64'))),
      ),
      head: log.head ? new CID(Buffer.from(log.head as string, 'base64')) : undefined,
      pubKey: keys.unmarshalPublicKey(Buffer.from(log.pubkey as string, 'base64')),
      // privKey,
    }
    logs.add(logInfo)
  }
  const addrs = new Set(
    proto.addrsList.map((addr) => new Multiaddr(Buffer.from(addr as string, 'base64'))),
  )
  return { id, key, logs, addrs }
}

/**
 * Client is a web-gRPC wrapper client for communicating with a webgRPC-enabled Textile server.
 * This client library can be used to interact with a local or remote Threads gRPC Network.
 */
export class Client implements Network {
  /**
   * Controls the remote API settings.
   */
  public serviceHost: string
  public rpcOptions: grpc.RpcOptions
  /**
   * Creates a new gRPC client instance for accessing the Textile Threads API.
   * @param context The context to use for interacting with the APIs. Can be modified later.
   */
  constructor(public context: ContextInterface = new Context('http://127.0.0.1:6007')) {
    this.serviceHost = context.host
    this.rpcOptions = {
      transport: context.transport,
      debug: context.debug,
    }
    // If we have a default here, use it. Otherwise, rely on specific calls
    this.rpcOptions.transport && grpc.setDefaultTransport(this.rpcOptions.transport)
  }

  /**
   * Create a random user identity.
   */
  static async randomIdentity() {
    return Libp2pCryptoIdentity.fromRandom()
  }

  /**
   * Obtain a token for interacting with the remote API.
   * @param identity A user identity to use for creating records in the database. A random identity
   * can be created with `Client.randomIdentity(), however, it is not easy/possible to migrate
   * identities after the fact. Please store or otherwise persist any identity information if
   * you wish to retrieve user data later, or use an external identity provider.
   * @param ctx Context object containing web-gRPC headers and settings.
   */
  async getToken(identity: Identity, ctx?: ContextInterface) {
    return this.getTokenChallenge(
      identity.public.toString(),
      async (challenge: Uint8Array) => {
        return identity.sign(challenge)
      },
      ctx,
    )
  }

  /**
   * Obtain a token for interacting with the remote API.
   * @param publicKey The public key of a user identity to use for creating records in the database.
   * A random identity can be created with `Client.randomIdentity(), however, it is not
   * easy/possible to migrate identities after the fact. Please store or otherwise persist any
   * identity information if you wish to retrieve user data later, or use an external identity
   * provider.
   * @param callback A callback function that takes a `challenge` argument and returns a signed
   * message using the input challenge and the private key associated with `publicKey`.
   * @param ctx Context object containing web-gRPC headers and settings.
   * @note `publicKey` must be the corresponding public key of the private key used in `callback`.
   */
  async getTokenChallenge(
    publicKey: string,
    callback: (challenge: Uint8Array) => Uint8Array | Promise<Uint8Array>,
    ctx?: ContextInterface,
  ) {
    const client = grpc.client<pb.GetTokenRequest, pb.GetTokenReply, APIGetToken>(API.GetToken, {
      host: this.serviceHost,
      transport: this.rpcOptions.transport,
      debug: this.rpcOptions.debug,
    })
    return new Promise<string>((resolve, reject) => {
      let token = ''
      client.onMessage(async (message: pb.GetTokenReply) => {
        if (message.hasChallenge()) {
          const challenge = message.getChallenge_asU8()
          const signature = await callback(challenge)
          const req = new pb.GetTokenRequest()
          req.setSignature(signature)
          client.send(req)
          client.finishSend()
        } else if (message.hasToken()) {
          token = message.getToken()
        }
      })
      client.onEnd((code: grpc.Code, message: string, _trailers: grpc.Metadata) => {
        client.close()
        if (code === grpc.Code.OK) {
          this.context.withToken(token)
          resolve(token)
        } else {
          reject(new Error(message))
        }
      })
      const req = new pb.GetTokenRequest()
      req.setKey(publicKey)
      const metadata = { ...this.context.toJSON(), ...ctx?.toJSON() }
      client.start(metadata)
      client.send(req)
    })
  }

  /**
   * getHostID returns the network's (remote) host peer ID.
   * @param ctx Context object containing web-gRPC headers and settings.
   */
  async getHostID(ctx?: ContextInterface) {
    logger.debug('making get host ID request')
    const req = new pb.GetHostIDRequest()
    const res: pb.GetHostIDReply = await this.unary(API.GetHostID, req, ctx)
    return PeerId.createFromBytes(Buffer.from(res.getPeerid_asU8()))
  }

  /**
   * createThread with id.
   * @param id The Thread id.
   * @param opts The set of keys to use when creating the Thread. All keys are "optional", though if no replicator key
   * is provided, one will be created (and returned) on the remote network. Similarly, if no LogKey is provided, then
   * a private key will be generated (and returned) on the remote network. If no ReadKey is provided, the remote
   * network will be unable to write records (but it can return records).
   * @param ctx Context object containing web-gRPC headers and settings.
   */
  async createThread(id: ThreadID, opts: NewThreadOptions, ctx?: ContextInterface) {
    logger.debug('making create thread request')
    const keys = getThreadKeys(opts)
    const req = new pb.CreateThreadRequest()
    req.setThreadid(id.toBytes())
    req.setKeys(keys)
    const res: pb.ThreadInfoReply = await this.unary(API.CreateThread, req, ctx)
    return threadInfoFromProto(res.toObject())
  }

  /**
   * addThread from a multiaddress.
   * @param addr The Thread multiaddr.
   * @param opts The set of keys to use when adding the Thread.
   * @param ctx Context object containing web-gRPC headers and settings.
   */
  async addThread(addr: Multiaddr, opts: NewThreadOptions, ctx?: ContextInterface) {
    logger.debug('making add thread request')
    const keys = getThreadKeys(opts)
    const req = new pb.AddThreadRequest()
    req.setAddr(addr.buffer)
    req.setKeys(keys)
    const res: pb.ThreadInfoReply = await this.unary(API.AddThread, req, ctx)
    return threadInfoFromProto(res.toObject())
  }

  /**
   * getThread with id.
   * @param id The Thread ID.
   * @param ctx Context object containing web-gRPC headers and settings.
   */
  async getThread(id: ThreadID, ctx?: ContextInterface) {
    logger.debug('making get thread request')
    const req = new pb.GetThreadRequest()
    req.setThreadid(id.toBytes())
    const res: pb.ThreadInfoReply = await this.unary(API.GetThread, req, ctx)
    return threadInfoFromProto(res.toObject())
  }

  /**
   * pullThread for new records.
   * @param id The Thread ID.
   * @param ctx Context object containing web-gRPC headers and settings.
   */
  async pullThread(id: ThreadID, ctx?: ContextInterface) {
    logger.debug('making pull thread request')
    const req = new pb.PullThreadRequest()
    req.setThreadid(id.toBytes())
    await this.unary(API.PullThread, req, ctx)
    return
  }

  /**
   * deleteThread with id.
   * @param id The Thread ID.
   * @param ctx Context object containing web-gRPC headers and settings.
   */
  async deleteThread(id: ThreadID, ctx?: ContextInterface) {
    logger.debug('making delete thread request')
    const req = new pb.DeleteThreadRequest()
    req.setThreadid(id.toBytes())
    await this.unary(API.DeleteThread, req, ctx)
    return
  }

  /**
   * addReplicator to a thread.
   * @param id The Thread ID.
   * @param addr The multiaddress of the replicator peer.
   * @param ctx Context object containing web-gRPC headers and settings.
   */
  async addReplicator(id: ThreadID, addr: Multiaddr, ctx?: ContextInterface) {
    logger.debug('making add replicator request')
    const req = new pb.AddReplicatorRequest()
    req.setThreadid(id.toBytes())
    req.setAddr(addr.buffer)
    const res: pb.AddReplicatorReply = await this.unary(API.AddReplicator, req, ctx)
    return PeerId.createFromBytes(Buffer.from(res.getPeerid_asU8()))
  }

  /**
   * createRecord with body.
   * @param id The Thread ID.
   * @param body The body to add as content.
   * @param ctx Context object containing web-gRPC headers and settings.
   */
  async createRecord(id: ThreadID, body: any, ctx?: ContextInterface) {
    logger.debug('making create record request')
    const info = await this.getThread(id, ctx)
    const block = Block.encoder(body, 'dag-cbor').encode()
    const req = new pb.CreateRecordRequest()
    req.setThreadid(id.toBytes())
    req.setBody(block)
    const res: pb.NewRecordReply = await this.unary(API.CreateRecord, req, ctx)
    return info.key && threadRecordFromProto(res.toObject(), info.key)
  }

  /**
   * addRecord to the given log.
   * @param id The Thread ID.
   * @param logID The Log ID.
   * @param rec The log record to add.
   * @param ctx Context object containing web-gRPC headers and settings.
   */
  async addRecord(id: ThreadID, logID: LogID, rec: LogRecord, ctx?: ContextInterface) {
    logger.debug('making add record request')
    const prec = recordToProto(rec)
    const req = new pb.AddRecordRequest()
    req.setThreadid(id.toBytes())
    req.setLogid(logID.toBytes())
    const record = new pb.Record()
    record.setBodynode(prec.bodynode)
    record.setEventnode(prec.eventnode)
    record.setHeadernode(prec.headernode)
    record.setRecordnode(prec.recordnode)
    req.setRecord(record)
    await this.unary(API.AddRecord, req, ctx)
    return
  }

  /**
   * getRecord returns the record at cid.
   * @param id The Thread ID.
   * @param rec The record's CID.
   * @param ctx Context object containing web-gRPC headers and settings.
   */
  async getRecord(id: ThreadID, rec: CID, ctx?: ContextInterface) {
    logger.debug('making get record request')
    const info = await this.getThread(id, ctx)
    if (info.key === undefined) throw new Error('Missing thread keys')
    const req = new pb.GetRecordRequest()
    req.setThreadid(id.toBytes())
    req.setRecordid(rec.buffer)
    const proto: pb.GetRecordReply = await this.unary(API.GetRecord, req, ctx)
    const record = proto.toObject()
    if (!record.record) throw new Error('Missing return value')
    return recordFromProto(record.record, info.key.service)
  }

  /**
   * subscribe to new record events in the given threads.
   * @param cb The callback to call on each new thread record.
   * @param threads The variadic set of threads to subscribe to.
   * @param ctx Context object containing web-gRPC headers and settings.
   */
  subscribe(
    cb: (rec?: ThreadRecord, err?: Error) => void,
    threads: ThreadID[] = [],
    ctx?: ContextInterface,
  ): grpc.Request {
    logger.debug('making subscribe request')
    const ids = threads.map((thread) => thread.toBytes())
    const request = new pb.SubscribeRequest()
    request.setThreadidsList(ids)
    const keys = new Map<ThreadID, Uint8Array | undefined>() // replicator key cache
    const callback = async (reply?: pb.NewRecordReply, err?: Error) => {
      if (!reply) {
        return cb(undefined, err)
      }
      const proto = reply.toObject()
      const id = ThreadID.fromBytes(Buffer.from(reply.getThreadid_asU8()))
      const logID = PeerId.createFromBytes(Buffer.from(reply.getLogid_asU8()))
      if (!keys.has(id)) {
        const info = await this.getThread(id, ctx)
        keys.set(id, info.key?.service)
      }
      const keyiv = keys.get(id)
      if (!keyiv) return cb(undefined, new Error('Missing key'))
      const record = proto.record && recordFromProto(proto.record, keyiv)
      return cb(
        {
          record,
          threadID: id,
          logID,
        },
        err,
      )
    }
    const creds = this.context.withContext(ctx)
    const metadata = JSON.parse(JSON.stringify(creds))
    return grpc.invoke(API.Subscribe, {
      host: this.serviceHost,
      transport: this.rpcOptions.transport,
      debug: this.rpcOptions.debug,
      metadata,
      request,
      onMessage: (rec: pb.NewRecordReply) => nextTick(() => callback(rec)),
      onEnd: (status: grpc.Code, message: string, _trailers: grpc.Metadata) => {
        if (status !== grpc.Code.OK) {
          return nextTick(() => callback(undefined, new Error(message)))
        }
        return nextTick(() => callback())
      },
    })
  }

  private unary<
    R extends grpc.ProtobufMessage,
    T extends grpc.ProtobufMessage,
    M extends grpc.UnaryMethodDefinition<R, T>
  >(methodDescriptor: M, req: R, context?: ContextInterface): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const creds = this.context.withContext(context)
      grpc.unary(methodDescriptor, {
        request: req,
        host: this.serviceHost,
        transport: this.rpcOptions.transport,
        debug: this.rpcOptions.debug,
        metadata: JSON.parse(JSON.stringify(creds)),
        onEnd: (res: grpc.UnaryOutput<T>) => {
          const { status, statusMessage, message } = res
          if (status === grpc.Code.OK) {
            if (message) {
              resolve(message)
            } else {
              resolve()
            }
          } else {
            reject(new Error(statusMessage))
          }
        },
      })
    })
  }
}
