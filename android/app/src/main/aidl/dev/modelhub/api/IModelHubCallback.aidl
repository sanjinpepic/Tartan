package dev.modelhub.api;

/** How a request to Model Hub goes. Each request ends with exactly one onDone or onError. */
oneway interface IModelHubCallback {
    /** Progress, as JSON with a "type": "load" (a processor tried), "queued" (waiting for another app's answer). */
    void onEvent(String json) = 0;

    /** The next piece of the answer. */
    void onText(String delta) = 1;

    /** The next piece of the model's thinking (only when the message asked for thinking). */
    void onThinking(String delta) = 2;

    /** The request is done; its result as JSON. */
    void onDone(String json) = 3;

    /** The request failed: one of the codes in ModelHubContract, and a message to show a person. */
    void onError(int code, String message) = 4;
}
