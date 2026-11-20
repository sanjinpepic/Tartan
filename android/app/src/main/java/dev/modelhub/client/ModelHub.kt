package dev.modelhub.client

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.os.IBinder
import android.os.ParcelFileDescriptor
import android.os.RemoteException
import dev.modelhub.api.IModelHub
import dev.modelhub.api.IModelHubCallback
import dev.modelhub.api.ModelHubContract
import java.io.Closeable
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.buffer
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.last
import kotlinx.coroutines.flow.mapNotNull
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject

/**
 * The models downloaded in Model Hub, for this app. One instance per app is enough; it connects
 * on first use and stays connected until [close].
 *
 * ```
 * val hub = ModelHub(context)
 * // Once: the person allows this app to use the models (a runtime permission).
 * if (!ModelHub.hasPermission(context)) activity.requestPermissions(arrayOf(ModelHub.PERMISSION), 1)
 *
 * hub.generate("Say hello in Croatian.").collect { print(it) }
 *
 * val chat = hub.open(ConversationOptions(system = "You are a running coach."))
 * val answer = chat.ask(Message("How far should I run today?"))
 * ```
 */
class ModelHub(context: Context) : Closeable {
  private val app = context.applicationContext
  private val hub = MutableStateFlow<IModelHub?>(null)
  private val bindLock = Mutex()
  private var connection: ServiceConnection? = null
  /** Requests waiting for Model Hub: they fail at once if its process goes away. */
  private val pending = ConcurrentHashMap.newKeySet<(ModelHubException) -> Unit>()

  companion object {
    /** The permission to ask for (Activity.requestPermissions) before using the models. */
    const val PERMISSION = ModelHubContract.PERMISSION

    /** Model Hub is installed on this phone. */
    fun isInstalled(context: Context): Boolean =
      try {
        context.packageManager.getPackageInfo(ModelHubContract.HUB_PACKAGE, 0)
        true
      } catch (_: PackageManager.NameNotFoundException) {
        false
      }

    /** The person has allowed this app to use Model Hub's models. */
    fun hasPermission(context: Context): Boolean =
      context.checkSelfPermission(PERMISSION) == PackageManager.PERMISSION_GRANTED

    /** Opens Model Hub's Updates screen (new versions of the models, and new models). */
    fun updatesIntent(): Intent =
      Intent(Intent.ACTION_VIEW, android.net.Uri.parse("com.google.ai.edge.gallery://model_updates"))
        .setPackage(ModelHubContract.HUB_PACKAGE)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    /** Opens Model Hub, to download a model or change its settings. Null if it isn't installed. */
    fun launchIntent(context: Context): Intent? =
      context.packageManager.getLaunchIntentForPackage(ModelHubContract.HUB_PACKAGE)
  }

  /** Connects to Model Hub (once; later calls return at once). */
  suspend fun connect(): IModelHub {
    hub.value?.takeIf { it.asBinder().isBinderAlive }?.let { return it }
    bindLock.withLock { if (connection == null) bind() }
    val h =
      withTimeoutOrNull(15_000) { hub.first { it != null } }
        ?: throw ModelHubException(ModelHubContract.ERROR_HUB_UNAVAILABLE, "Model Hub didn't answer.")
    val version = remote { h.apiVersion() }
    if (version < ModelHubContract.API_VERSION) {
      throw ModelHubException(
        ModelHubContract.ERROR_VERSION,
        "Model Hub is too old for this app (API $version, needs ${ModelHubContract.API_VERSION}). Update Model Hub.",
      )
    }
    return h
  }

  private fun bind() {
    if (!isInstalled(app)) {
      throw ModelHubException(ModelHubContract.ERROR_HUB_UNAVAILABLE, "Model Hub isn't installed.")
    }
    if (!hasPermission(app)) {
      throw ModelHubException(
        ModelHubContract.ERROR_PERMISSION,
        "This app isn't allowed to use Model Hub's models yet.",
      )
    }
    val conn =
      object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName, binder: IBinder) {
          val h = IModelHub.Stub.asInterface(binder)
          try {
            binder.linkToDeath({ gone() }, 0)
          } catch (_: RemoteException) {
            return gone()
          }
          hub.value = h
        }

        // Android binds again by itself when Model Hub's process comes back.
        override fun onServiceDisconnected(name: ComponentName) = gone()

        override fun onBindingDied(name: ComponentName) {
          gone()
          unbind()
        }

        override fun onNullBinding(name: ComponentName) = unbind()
      }
    val intent = Intent(ModelHubContract.ACTION_BIND).setPackage(ModelHubContract.HUB_PACKAGE)
    val ok =
      try {
        app.bindService(intent, conn, Context.BIND_AUTO_CREATE)
      } catch (e: SecurityException) {
        throw ModelHubException(
          ModelHubContract.ERROR_PERMISSION,
          "This app isn't allowed to use Model Hub's models.",
          e,
        )
      }
    if (!ok) {
      runCatching { app.unbindService(conn) }
      throw ModelHubException(ModelHubContract.ERROR_HUB_UNAVAILABLE, "Couldn't connect to Model Hub.")
    }
    connection = conn
  }

  private fun unbind() {
    connection?.let { runCatching { app.unbindService(it) } }
    connection = null
    hub.value = null
  }

  /** Model Hub's process went away (out of memory, updated, stopped): what was waiting fails. */
  private fun gone() {
    hub.value = null
    val e =
      ModelHubException(
        ModelHubContract.ERROR_HUB_UNAVAILABLE,
        "Model Hub stopped (the phone may have run out of memory). Try again.",
      )
    pending.toList().forEach { it(e) }
  }

  /** Lets go of Model Hub. Conversations opened through this instance can't be used after. */
  override fun close() {
    unbind()
    gone()
  }

  /** The models downloaded in Model Hub. */
  suspend fun models(): List<HubModel> {
    val o = JSONObject(remote(connect()) { listModels() })
    val default = o.optString("defaultModel").takeIf { it.isNotEmpty() }
    val a = o.optJSONArray("models") ?: return emptyList()
    return (0 until a.length()).map { HubModel.from(a.getJSONObject(it), default) }
  }

  /** What Model Hub has loaded now. */
  suspend fun status(): HubStatus = HubStatus(JSONObject(remote(connect()) { status() }))

  /**
   * Loads a model now (optional: conversations load what they need). [onEvent] gets each
   * processor tried. Gives the status once it's loaded.
   */
  suspend fun load(
    model: String? = null,
    backend: String? = null,
    maxTokens: Int? = null,
    vision: Boolean? = null,
    audio: Boolean? = null,
    onEvent: (JSONObject) -> Unit = {},
  ): HubStatus {
    val o =
      JSONObject().apply {
        model?.let { put("model", it) }
        backend?.let { put("backend", it) }
        maxTokens?.let { put("maxTokens", it) }
        vision?.let { put("vision", it) }
        audio?.let { put("audio", it) }
      }
    val done =
      call { h, cb -> h.load(o.toString(), cb) }
        .mapNotNull { r -> if (r is Raw.Event) onEvent(r.json).let { null } else r as? Raw.Done }
        .last()
    return HubStatus(done.json)
  }

  /** Opens a conversation. */
  suspend fun open(options: ConversationOptions = ConversationOptions()): Conversation {
    val id = openId(options, emptyList())
    return Conversation(this, options, id)
  }

  internal suspend fun openId(options: ConversationOptions, more: List<Turn>): String {
    val done =
      call { h, cb -> h.open(options.toJson(more).toString(), cb) }.filter { it is Raw.Done }.last()
        as Raw.Done
    return done.json.getString("conversation")
  }

  /** Lets the model go now, if no other app is using it. */
  suspend fun unload() = remote(connect()) { unload() }

  /**
   * One question, one answer, as the answer is written (the conversation is closed after).
   * For more than text, or a chat, use [open].
   */
  fun generate(prompt: String, system: String? = null, model: String? = null): Flow<String> = flow {
    val c = open(ConversationOptions(model = model, system = system))
    try {
      c.send(Message(prompt)).collect { if (it is HubEvent.Text) emit(it.delta) }
    } finally {
      c.close()
    }
  }

  internal sealed class Raw {
    data class Event(val json: JSONObject) : Raw()

    data class Text(val delta: String) : Raw()

    data class Thinking(val delta: String) : Raw()

    data class Done(val json: JSONObject) : Raw()
  }

  /**
   * A request with a callback, as a flow that ends with its Done (or throws its error). If the
   * flow is cancelled before that, [onCancel] runs (to stop the answer in Model Hub).
   */
  internal fun call(
    attachments: List<ByteArray> = emptyList(),
    onCancel: (IModelHub) -> Unit = {},
    start: (IModelHub, IModelHubCallback, Array<ParcelFileDescriptor>) -> Unit,
  ): Flow<Raw> =
    callbackFlow {
        val h = connect()
        val finished = AtomicBoolean(false)
        val fail: (ModelHubException) -> Unit = { e -> if (finished.compareAndSet(false, true)) close(e) }
        val cb =
          object : IModelHubCallback.Stub() {
            override fun onEvent(json: String) {
              trySend(Raw.Event(JSONObject(json)))
            }

            override fun onText(delta: String) {
              trySend(Raw.Text(delta))
            }

            override fun onThinking(delta: String) {
              trySend(Raw.Thinking(delta))
            }

            override fun onDone(json: String) {
              if (finished.compareAndSet(false, true)) {
                trySend(Raw.Done(JSONObject(json)))
                close()
              }
            }

            override fun onError(code: Int, message: String) = fail(ModelHubException(code, message))
          }
        pending += fail
        val pipes = attachments.map { pipe(it) }
        try {
          start(h, cb, pipes.toTypedArray())
        } catch (e: SecurityException) {
          fail(ModelHubException(ModelHubContract.ERROR_PERMISSION, e.message ?: "Not allowed.", e))
        } catch (e: RemoteException) {
          fail(ModelHubException(ModelHubContract.ERROR_HUB_UNAVAILABLE, "Model Hub stopped. Try again.", e))
        } finally {
          // Model Hub has its own copies of the descriptors now.
          pipes.forEach { runCatching { it.close() } }
        }
        awaitClose {
          pending -= fail
          if (finished.compareAndSet(false, true)) runCatching { onCancel(h) }
        }
      }
      .buffer(Channel.UNLIMITED)

  internal fun call(start: (IModelHub, IModelHubCallback) -> Unit): Flow<Raw> =
    call(emptyList(), {}) { h, cb, _ -> start(h, cb) }

  /** The read end of a pipe that [bytes] are written into (on a thread of its own). */
  private fun pipe(bytes: ByteArray): ParcelFileDescriptor {
    val (read, write) = ParcelFileDescriptor.createPipe()
    thread(isDaemon = true, name = "ModelHub-attachment") {
      // Fails (and ends) if Model Hub closes its end without reading it all.
      runCatching { ParcelFileDescriptor.AutoCloseOutputStream(write).use { it.write(bytes) } }
    }
    return read
  }

  private suspend fun <T> remote(block: () -> T): T =
    withContext(Dispatchers.IO) {
      try {
        block()
      } catch (e: SecurityException) {
        throw ModelHubException(ModelHubContract.ERROR_PERMISSION, e.message ?: "Not allowed.", e)
      } catch (e: RemoteException) {
        throw ModelHubException(ModelHubContract.ERROR_HUB_UNAVAILABLE, "Model Hub stopped. Try again.", e)
      }
    }

  private suspend fun <T> remote(h: IModelHub, block: IModelHub.() -> T): T = remote { h.block() }

  internal suspend fun cancel(id: String) = runCatching { remote(connect()) { cancel(id) } }

  internal fun closeConversation(id: String) {
    val h = hub.value ?: return
    thread(isDaemon = true, name = "ModelHub-close") { runCatching { h.close(id) } }
  }
}

/**
 * A chat with the model in Model Hub. It remembers what was said, so if Model Hub was restarted
 * in between (the phone needed the memory), the next [send] opens it again from there.
 */
class Conversation
internal constructor(
  private val hub: ModelHub,
  private val options: ConversationOptions,
  @Volatile var id: String,
) : Closeable {
  private val said = mutableListOf<Turn>()
  private val lock = Mutex()

  /** The turns of this chat so far (after [ConversationOptions.history]). */
  val turns: List<Turn>
    get() = synchronized(said) { said.toList() }

  /**
   * Sends [message]; the answer arrives as it's written, ending with [HubEvent.Answered]. One
   * message at a time per conversation. Cancelling the collection stops the answer.
   */
  fun send(message: Message): Flow<HubEvent> = flow {
    lock.withLock {
      var answer: Answer? = null
      var reopened = false
      while (true) {
        var started = false
        try {
          once(message).collect { r ->
            started = true
            when (r) {
              is ModelHub.Raw.Event -> emit(HubEvent.Progress(r.json))
              is ModelHub.Raw.Text -> emit(HubEvent.Text(r.delta))
              is ModelHub.Raw.Thinking -> emit(HubEvent.Thinking(r.delta))
              is ModelHub.Raw.Done -> answer = Answer.from(r.json).also { emit(HubEvent.Answered(it)) }
            }
          }
          break
        } catch (e: ModelHubException) {
          // Model Hub doesn't know this conversation (it was restarted): open it again from what
          // was said, and send the message once more. Only before anything of the answer came.
          if (e.code != ModelHubContract.ERROR_NO_CONVERSATION || started || reopened) throw e
          reopened = true
          id = hub.openId(options, turns)
        }
      }
      answer?.let { a ->
        synchronized(said) {
          if (message.toolResults.isNotEmpty()) said += Turn.Tool(message.toolResults)
          if (message.text != null) said += Turn.User(message.text)
          said += Turn.Model(a.text, a.toolCalls)
        }
      }
    }
  }

  private fun once(message: Message): Flow<ModelHub.Raw> {
    val sentTo = id
    return hub.call(message.attachments, onCancel = { h -> runCatching { h.cancel(sentTo) } }) { h, cb, fds ->
      h.send(sentTo, message.toJson().toString(), fds, cb)
    }
  }

  /** Sends [message] and waits for the whole answer. */
  suspend fun ask(message: Message): Answer =
    (send(message).filter { it is HubEvent.Answered }.last() as HubEvent.Answered).answer

  /** Sends [text] and gives the answer's words as they're written. */
  fun stream(text: String): Flow<String> =
    send(Message(text)).mapNotNull { (it as? HubEvent.Text)?.delta }

  /** Stops the answer being written. */
  suspend fun cancel() {
    hub.cancel(id)
  }

  /** Closes the conversation in Model Hub (frees its memory there). Returns at once. */
  override fun close() {
    hub.closeConversation(id)
  }
}
