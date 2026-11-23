// Model Hub's API: other apps on the phone use the models downloaded in Model Hub.
//
// Requests and replies are JSON (see API.md at the repository root), so fields can be added
// without changing this interface. Methods that take a callback return at once; the work goes on
// in Model Hub and its outcome arrives on the callback (onDone or onError, exactly one of them).
//
// Callers need the permission dev.modelhub.permission.USE_MODELS (a runtime permission: the app
// asks for it and the person allows it).
package dev.modelhub.api;

import android.os.ParcelFileDescriptor;
import dev.modelhub.api.IModelHubCallback;

interface IModelHub {
    /** The version of this API that Model Hub speaks (1 for now). */
    int apiVersion() = 0;

    /** The models that are downloaded and ready: {"models":[{...}], "defaultModel":"..."}. */
    String listModels() = 1;

    /** What is loaded now: {"loaded":bool, "model", "backend", "contextTokens", "vision", "audio", "busy", ...}. */
    String status() = 2;

    /**
     * Loads a model now, so the first answer comes quicker. Optional: open() and send() load
     * the model they need themselves. Options: {"model", "backend", "maxTokens", "vision", "audio"}.
     * onEvent gets each try ({"type":"load", "backend", "ok", "error"}); onDone gets status().
     */
    void load(String optionsJson, IModelHubCallback callback) = 3;

    /**
     * Opens a conversation: {"model", "system", "tools":[OpenAPI function JSON...], "history":
     * [{"role":"user"|"model", "text"}], "temperature", "topK", "topP", "constrainedToolCalls"}.
     * onDone gets {"conversation": id, "model": name}.
     */
    void open(String configJson, IModelHubCallback callback) = 4;

    /**
     * Sends a message to a conversation: {"text", "images":[index...], "audio":[index...],
     * "toolResults":[{"name", "result"}], "thinking":bool, "maxOutputTokens"}. Images and audio are
     * read from attachments[index] (a pipe or file the caller opened). onText and onThinking get the
     * answer as it's written; onDone gets {"text", "thinking", "toolCalls":[{"name","args"}], "stats"}.
     */
    void send(String conversationId, String messageJson, in ParcelFileDescriptor[] attachments, IModelHubCallback callback) = 5;

    /** Stops the answer being written in this conversation (its send() ends with onError CANCELLED). */
    void cancel(String conversationId) = 6;

    /** Closes a conversation and frees its memory. */
    void close(String conversationId) = 7;

    /** Lets the model go now (frees its memory) if no other app is using it. */
    void unload() = 8;
}
