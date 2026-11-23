package dev.modelhub.api

/** What Model Hub and the apps that use it agree on: names, the API version and error codes. */
object ModelHubContract {
  /** The version of the API described in API.md. Raised only when something incompatible changes. */
  const val API_VERSION = 1

  /** Model Hub's package (its applicationId). */
  const val HUB_PACKAGE = "dev.modelhub"

  /** The intent action Model Hub's service answers to. */
  const val ACTION_BIND = "dev.modelhub.action.BIND"

  /** The runtime permission an app needs to use the models. */
  const val PERMISSION = "dev.modelhub.permission.USE_MODELS"

  // Error codes (IModelHubCallback.onError and ModelHubException.code).

  /** The app doesn't have [PERMISSION], or the person turned the API off in Model Hub. */
  const val ERROR_PERMISSION = 1

  /** No model is downloaded in Model Hub yet (or none of the kind asked for). */
  const val ERROR_NO_MODEL = 2

  /** No downloaded model has the name asked for. */
  const val ERROR_MODEL_NOT_FOUND = 3

  /** The model didn't start on any of the phone's processors. */
  const val ERROR_LOAD_FAILED = 4

  /** No such conversation (closed, or Model Hub was restarted): open it again with its history. */
  const val ERROR_NO_CONVERSATION = 5

  /** The request isn't valid JSON or misses something it needs. */
  const val ERROR_BAD_REQUEST = 6

  /** The model failed while writing the answer. */
  const val ERROR_GENERATION_FAILED = 7

  /** The answer was stopped with cancel(). */
  const val ERROR_CANCELLED = 8

  /** The model can't take this input (a photo for a text-only model, say). */
  const val ERROR_UNSUPPORTED = 9

  /** Model Hub isn't installed, or its process went away. */
  const val ERROR_HUB_UNAVAILABLE = 10

  /** Model Hub speaks an older API than this app needs. */
  const val ERROR_VERSION = 11

  /**
   * The app holds the permission, but the person hasn't approved it in Model Hub yet (Model Hub
   * shows a notification to approve it), or denied it there. The message says which.
   */
  const val ERROR_NOT_APPROVED = 12
}
