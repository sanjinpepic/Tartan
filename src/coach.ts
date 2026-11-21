/**
 * The in-app coach: a chat with Claude that reads your merged training data through the
 * same tools the MCP server exposes (read-only). Runs on your PC or inside the Android app,
 * with your own Anthropic API key; conversations are stored under coach/ in the data folder
 * and only ever appended to.
 *
 * This file is the coach's public surface and its routing (which provider answers a turn, the
 * phone's chats handed to the cloud, plans and weekly reviews). The rest is in src/coach/:
 * settings.ts (providers, models, settings), labels.ts (steps in words), routing.ts (routeOf),
 * prompt.ts, conversation.ts (conversations, events, photos), route-tools.ts, plan-tools.ts,
 * and one turn loop per provider: turn-claude.ts, turn-gemini.ts, turn-local.ts (Model Hub).
 * Those take the Coach itself, so the members they use aren't private.
 */
import Anthropic from "@anthropic-ai/sdk";
// The Gemini module (and Google's SDK) loads only when a Gemini conversation or model list needs it.
const gemini = () => import("./coach-gemini.ts");
import { env, readJson } from "./disk.ts";
import { Analytics } from "./analytics.ts";
import { type Get } from "./route-finder.ts";
import { type LngLat } from "./routes.ts";
import type { Library } from "./library.ts";
import { mondayOf, Plans, today, type ProposalSource } from "./plan.ts";
import { dataTools, type DataTool } from "./tools.ts";
import { Memory } from "./memory.ts";
import { hubReady, prepareLocal, type HubState, type ModelHubClient } from "./coach-litert.ts";
import { COACH_PROVIDERS, current, GONE_PHONE, hubLabel, MODEL_ID, modelLabel, ON_PHONE, planModelFor, TURN, wasOnPhone, type CoachSettings, type Planner, type Provider } from "./coach/settings.ts";
import { effortOf, routeOf, type Effort } from "./coach/routing.ts";
import { localHistory, num1, okImage, shown, type ChatImage, type ChatOptions, type CoachEvent, type Conversation, type Reply } from "./coach/conversation.ts";
import { makeRouteTool, routeFromRunTool, showRouteTool, type RouteCard } from "./coach/route-tools.ts";
import { changePlanTool, editSessionTool, planOnDevice, rulesReplan, saveTrainingPlanTool } from "./coach/plan-tools.ts";
import { chatClaude } from "./coach/turn-claude.ts";
import { chatGemini } from "./coach/turn-gemini.ts";
import { chatLocal, localSystem } from "./coach/turn-local.ts";
import { VOICE_LINE } from "./coach/prompt.ts";

// The coach's public surface: everything the app, the API and the tests import from here.
export { COACH_MODELS, COACH_PROVIDERS, planModelFor, type CoachSettings, type Planner, type Provider } from "./coach/settings.ts";
export { TOOL_LABELS, toolLabel } from "./coach/labels.ts";
export { routeOf } from "./coach/routing.ts";
export { routeCard, type RouteCard } from "./coach/route-tools.ts";
export type { ChatImage, ChatOptions, CoachEvent } from "./coach/conversation.ts";

/** The cloud model a phone chat hands its turn to (cloudFor). */
export type CloudPick = { id: Provider; model: string; label: string; planModel: string; planLabel: string };

export class Coach {
  readonly tools: DataTool[];

  constructor(
    readonly lib: Library,
    /**
     * Anthropic SDK options: a mock baseURL in tests; `dangerouslyAllowBrowser` in the Android
     * app, where the key is the user's own and never leaves their phone except to Anthropic.
     */
    readonly clientOptions: {
      baseURL?: string; fetch?: typeof fetch; dangerouslyAllowBrowser?: boolean; googleBaseUrl?: string; modelHub?: ModelHubClient;
      /** Routes the coach makes: where the phone is, and the watch to send one to (the phone only). Tests: the map services' address. */
      routes?: { whereAmI?: () => Promise<LngLat | null>; sendRoute?: (r: { name: string; line: LngLat[]; elevation?: number[]; waypoints: LngLat[] }) => Promise<{ id: number }>; get?: Get };
    } = {},
  ) {
    this.plans = new Plans(lib);
    this.memory = new Memory(lib.disk);
    // Read-only data tools, plus one write: the coach's own plan file.
    this.tools = [
      // Plus ticking a session off ("I did it, the watch stayed home"), swapping one on the day, and the time you have.
      ...dataTools(lib, { allowSync: false }).filter((t) => t.readOnly || ["mark_plan_session", "swap_plan_session", "log_workout", "remove_logged_workout", "set_training_availability", "set_training_times", "remember", "update_memory", "forget_memory"].includes(t.name)),
      saveTrainingPlanTool(this),
      makeRouteTool(this),
      routeFromRunTool(this),
      showRouteTool(this),
    ];
  }

  /** Routes shown this turn, as cards in the chat (made by make_route, or brought up by show_route). */
  routesShown: RouteCard[] = [];
  private takeRoutes(): RouteCard[] {
    const r = this.routesShown;
    this.routesShown = [];
    return r;
  }




  readonly plans: Plans;
  readonly memory: Memory;
  /** This turn's plan proposal (how many changes), and where the turn came from. */
  planProposed = 0;
  source: ProposalSource = "chat";

  /** The coach's notes for this turn: in a conversation's first turn, and again after they change. */
  async notesFor(conv: Conversation): Promise<string[]> {
    const stamp = await this.memory.stamp();
    if (!stamp || stamp === conv.memory) return [];
    const text = await this.memory.prompt();
    const first = conv.memory === undefined;
    conv.memory = stamp;
    if (!text) return first ? [] : ["You no longer have any notes about this athlete."];
    return [first ? text : `Your notes changed since earlier in this conversation. ${text}`];
  }
  /** The conversation whose turn is running (the plan records where it came from). */
  active: Conversation | null = null;
  /** The id a new chat prepared on Model Hub takes when its first question comes (prepare). */
  private nextNewId: string | null = null;
  planSaved: string | null = null;

  // ------------------------------------------------------------ settings

  async settings(): Promise<CoachSettings> {
    const s = (await readJson<CoachSettings>(this.lib.disk, "coach/settings.json")) ?? {};
    return { ...s, provider: current(s.provider) };
  }

  async saveSettings(s: CoachSettings): Promise<void> {
    const cur = await this.settings();
    const next: CoachSettings = { ...cur };
    if (s.provider && s.provider in COACH_PROVIDERS) next.provider = s.provider;
    if (s.apiKey !== undefined) next.apiKey = s.apiKey.trim() || undefined;
    if (s.googleKey !== undefined) next.googleKey = s.googleKey.trim() || undefined;
    // Any model id of the provider's shape: lists come from the key itself (Load models).
    if (s.model && MODEL_ID.anthropic.test(s.model)) next.model = s.model;
    if (s.googleModel && MODEL_ID.google.test(s.googleModel)) next.googleModel = s.googleModel;
    if (s.planner === "auto" || s.planner === "anthropic" || s.planner === "google" || s.planner === "rules") next.planner = s.planner;
    if (typeof s.photos === "boolean") next.photos = s.photos;
    if (typeof s.voice === "boolean") next.voice = s.voice;
    if (typeof s.phoneOnly === "boolean") next.phoneOnly = s.phoneOnly;
    await this.lib.disk.write("coach/settings.json", JSON.stringify(next), { secret: true });
  }

  keyFor(s: CoachSettings, p: Provider): { key?: string; source: string | null } {
    if (p === "google") {
      const k = s.googleKey ?? env("GEMINI_API_KEY") ?? env("GOOGLE_API_KEY");
      return { key: k, source: s.googleKey ? "saved in Tartan" : env("GEMINI_API_KEY") ? "GEMINI_API_KEY" : env("GOOGLE_API_KEY") ? "GOOGLE_API_KEY" : null };
    }
    return { key: s.apiKey, source: s.apiKey ? "saved in Tartan" : env("ANTHROPIC_API_KEY") ? "ANTHROPIC_API_KEY" : null };
  }

  /**
   * Model Hub's state, asked over IPC (another app: a cold one takes a while to answer). Fresh for
   * the settings and the chat's status; a turn's own checks take one up to `maxAge` old.
   */
  private hubMemo: { at: number; v: HubState | null } | null = null;
  private async hubState(maxAge = 0): Promise<HubState | null> {
    const h = this.clientOptions.modelHub;
    if (!h) return null;
    if (!this.hubMemo || Date.now() - this.hubMemo.at > maxAge) this.hubMemo = { at: Date.now(), v: await h.state().catch(() => null) };
    return this.hubMemo.v;
  }

  /** The coach's setup; `hubAge`: how old Model Hub's state may be (a turn's checks: no need to ask again). */
  async status(o: { hubAge?: number } = {}) {
    const s = await this.settings();
    const hub = await this.hubState(o.hubAge);
    // The phone's model is a choice only on a phone where Model Hub is installed.
    const offered = (Object.keys(COACH_PROVIDERS) as Provider[]).filter((id) => (id === "modelhub" ? !!hub?.installed : true));
    const provider = this.pickProvider(s.provider, offered, { hub, cloud: this.cloudWithKey(s) });
    const providers = offered.map((id) => ({
      id,
      ...COACH_PROVIDERS[id],
      keySource: id === "modelhub" ? (hubReady(hub) ? hub!.model! : null) : this.keyFor(s, id).source,
      model: (id === "google" ? s.googleModel : s.model) ?? COACH_PROVIDERS[id].defaultModel,
    }));
    const cur = providers.find((p) => p.id === provider)!;
    return { ready: !!cur.keySource, keySource: cur.keySource, provider, model: cur.model, models: cur.models, providers, photos: s.photos !== false, voice: s.voice !== false, phoneOnly: s.phoneOnly === true, answers: this.answersBy(s, provider, providers, hub), planner: this.plannerStatus(s, provider, providers), ...(hub ? { hub } : {}) };
  }

  /** The cloud providers you have a key for, Gemini first (its free tier covers a few plans a week). */
  private cloudWithKey(s: CoachSettings): Provider[] {
    return (["google", "anthropic"] as const).filter((p) => !!this.keyFor(s, p).source);
  }

  /** Who writes plans and runs weekly reviews (Planner), from the settings and the chat's provider. */
  private plannerOf(s: CoachSettings, chat: Provider): Provider | "rules" {
    const choice = s.planner ?? "auto";
    if (choice === "rules") return "rules";
    if (choice !== "auto") return this.keyFor(s, choice).source ? choice : "rules";
    if (!ON_PHONE.has(chat) && this.keyFor(s, chat).source) return chat;
    return this.cloudWithKey(s)[0] ?? "rules";
  }

  /**
   * Who answers the chat, in words: on the phone with a cloud key (and not kept on the phone), the
   * cloud model online and the phone offline.
   */
  private answersBy(s: CoachSettings, chat: Provider, providers: Array<{ id: Provider; model: string; keySource: string | null }>, hub: HubState | null): string {
    const phone = chat === "modelhub" ? `${hubLabel(hub?.model)} on your phone` : modelLabel(chat, providers.find((p) => p.id === chat)?.model ?? "");
    const cloud = ON_PHONE.has(chat) && !s.phoneOnly ? this.cloudPick(s, chat, providers) : null;
    return cloud ? `${modelLabel(cloud.id, cloud.model)}; offline, ${phone}` : phone;
  }

  /** The cloud provider a phone chat goes to: the planner's, else any with a key. */
  private cloudPick(s: CoachSettings, chat: Provider, providers: Array<{ id: Provider; model: string; keySource: string | null }>): { id: Provider; model: string } | null {
    const planner = this.plannerOf(s, chat);
    const id = planner !== "rules" ? planner : this.cloudWithKey(s)[0];
    const p = id ? providers.find((x) => x.id === id) : undefined;
    return id && p?.keySource ? { id, model: p.model } : null;
  }

  /** Who plans, and on which model (by name). */
  private plannerStatus(s: CoachSettings, chat: Provider, providers: Array<{ id: Provider; model: string }>): { choice: Planner; uses: Provider | "rules"; model?: string } {
    const uses = this.plannerOf(s, chat);
    const chosen = uses === "rules" ? undefined : providers.find((p) => p.id === uses)?.model;
    return { choice: s.planner ?? "auto", uses, ...(uses !== "rules" && chosen ? { model: modelLabel(uses, planModelFor(uses, chosen)) } : {}) };
  }

  /** Who writes plans and runs weekly reviews now. */
  async planner(): Promise<Provider | "rules"> {
    return (await this.status(TURN)).planner.uses;
  }

  /**
   * The provider the coach uses: the one chosen, while it's offered. Never chosen, Model Hub when it
   * can answer (the phone's models, downloaded once for every app). A phone provider that's gone
   * (Model Hub uninstalled, or Gemini Nano, which left in 2.56) falls back to Model Hub when it can
   * answer, else a cloud key you have (`cloud`, Gemini first), else Claude, which asks for a key
   * (plans then come from Tartan's rules).
   */
  private pickProvider(chosen: Provider | undefined, offered: Provider[], o: { hub: HubState | null; cloud: Provider[] }): Provider {
    if (chosen && offered.includes(chosen)) return chosen;
    const hub = offered.includes("modelhub") && hubReady(o.hub);
    if (!chosen) return hub ? "modelhub" : "anthropic";
    if (!wasOnPhone(chosen)) return "anthropic";
    if (hub) return "modelhub";
    return o.cloud[0] ?? "anthropic";
  }

  /** The models the provider's key can use, live from its API (falls back to the built-in list). */
  async listModels(provider: Provider): Promise<Array<{ id: string; label: string }>> {
    const s = await this.settings();
    const { key } = this.keyFor(s, provider);
    if (ON_PHONE.has(provider)) return COACH_PROVIDERS[provider].models;
    if (!key && provider === "google") throw new Error("Add a Gemini API key first.");
    if (provider === "google") return (await gemini()).geminiModels(key!, this.clientOptions.googleBaseUrl);
    const out: Array<{ id: string; label: string }> = [];
    for await (const m of (await this.client()).models.list()) if (m.id.startsWith("claude-")) out.push({ id: m.id, label: m.display_name });
    return out;
  }

  /**
   * Does this key work? Asked of the provider before it's saved (a model list costs nothing):
   * how many chat models it can use, or why not in plain words.
   */
  async checkKey(provider: "google" | "anthropic", key: string): Promise<{ ok: true; models: number } | { ok: false; error: string }> {
    const k = key.trim();
    // Gemini keys come in more than one shape (AIza…, and the newer AQ.…): Google itself says
    // whether one works. Only what's plainly not a Gemini key is turned away here.
    if (provider === "google" && (/^sk-ant-/.test(k) || !/^[\w.-]{20,}$/.test(k))) return { ok: false, error: "That doesn't look like a Gemini key. Copy the whole key from Google AI Studio." };
    if (provider === "anthropic" && !/^sk-ant-[\w-]{20,}$/.test(k)) return { ok: false, error: "That doesn't look like an Anthropic key: it starts with sk-ant-. Copy the whole key from the Anthropic Console." };
    try {
      if (provider === "google") return { ok: true, models: (await (await gemini()).geminiModels(k, this.clientOptions.googleBaseUrl)).length };
      const { baseURL, fetch, dangerouslyAllowBrowser } = this.clientOptions;
      let n = 0;
      for await (const m of new Anthropic({ apiKey: k, baseURL, fetch, dangerouslyAllowBrowser }).models.list()) if (m.id.startsWith("claude-") && ++n >= 40) break;
      return { ok: true, models: n };
    } catch (e) {
      const error =
        provider === "google" ? (await gemini()).geminiError(e)
        : e instanceof Anthropic.AuthenticationError ? "Anthropic rejected this key: copy it again from the Anthropic Console."
        : e instanceof Anthropic.APIConnectionError ? "Couldn't reach Anthropic: check the internet connection."
        : (e as Error).message;
      return { ok: false, error };
    }
  }

  /**
   * What shoe is in a photo (Settings → Training → Add a pair), on the coach's provider and your
   * key: the name as sold and whether it's a racing, daily or trail shoe. Null when it can't tell.
   */
  async recogniseShoe(photo: string): Promise<{ name: string | null; kind: "racing" | "daily" | "trail" }> {
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(photo);
    if (!m) throw new Error("that isn't a photo");
    const [, mime, data] = m as unknown as [string, "image/jpeg" | "image/png" | "image/webp", string];
    const status = await this.status();
    // On the phone's models, a cloud key you have reads it (the planner's, else any).
    const cloud = ON_PHONE.has(status.provider) ? (status.planner.uses !== "rules" ? status.planner.uses : this.cloudWithKey(await this.settings())[0]) : status.provider;
    if (!cloud) throw new Error("Reading a photo needs a cloud AI key (Claude or Gemini) in Coach settings; the phone's models can't yet.");
    const st = { provider: cloud, ready: !!this.keyFor(await this.settings(), cloud).source, model: status.providers.find((p) => p.id === cloud)?.model ?? COACH_PROVIDERS[cloud].defaultModel };
    if (!st.ready) throw new Error(`Add your ${COACH_PROVIDERS[st.provider].keyName} in Coach settings first.`);
    const ask = 'This is a photo of a running shoe. Reply with JSON only: {"name": the brand and model as sold, with its version number when you can see or tell it (for example "Nike Pegasus 41"), or null if it isn\'t a shoe or you can\'t tell; "kind": "racing" for carbon-plated or racing flats and spikes, "trail" for trail shoes, else "daily"}.';
    let text = "";
    if (st.provider === "google") {
      const g = await gemini();
      const { MediaResolution, ThinkingLevel } = await import("@google/genai");
      const key = this.keyFor(await this.settings(), "google").key!;
      const res = await g
        .geminiClient(key, this.clientOptions.googleBaseUrl)
        .models.generateContent({
          model: st.model,
          contents: [{ role: "user", parts: [{ inlineData: { mimeType: mime, data } }, { text: ask }] }],
          // A quick look at a shoe: a medium-sized image is plenty, little thinking, JSON for sure.
          config: {
            mediaResolution: MediaResolution.MEDIA_RESOLUTION_MEDIUM,
            responseMimeType: "application/json",
            responseJsonSchema: { type: "object", properties: { name: { type: ["string", "null"] }, kind: { type: "string", enum: ["daily", "racing", "trail"] } }, required: ["name", "kind"] },
            ...(g.thinksInLevels(st.model) ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } } : {}),
          },
        })
        .catch((e: unknown) => {
          throw new Error(g.geminiError(e));
        });
      text = res.text ?? "";
    } else {
      const res = await (await this.client()).messages.create({
        // A small look-up: the fast model does it well and costs little.
        model: "claude-haiku-5-5",
        max_tokens: 200,
        messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: mime, data } }, { type: "text", text: ask }] }],
      });
      text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    }
    const json = /\{[\s\S]*\}/.exec(text)?.[0];
    const out = json ? (JSON.parse(json) as { name?: unknown; kind?: unknown }) : {};
    const name = typeof out.name === "string" && out.name.trim() ? out.name.trim().slice(0, 40) : null;
    const kind = out.kind === "racing" || out.kind === "trail" ? out.kind : "daily";
    return { name, kind };
  }

  /**
   * The note after a run (src/after-run.ts) in the coach's own words: one or two short sentences
   * from the facts, by the chat's cloud model with a tight limit. Null (the rules' words stand)
   * without a cloud key, offline, on any error, or when it takes longer than `timeoutMs`.
   */
  async afterRunWords(draft: string, facts: string[], timeoutMs = 8000): Promise<string | null> {
    return this.quickWords(
      [
        `You are the athlete's running coach. ${VOICE_LINE}`,
        "Write the notification the athlete gets just after this run: one or two short sentences, at most 200 characters.",
        "Use only these facts; keep their numbers exact; plain words; no greeting, no emoji, no exclamation marks, no lists. Say how it went and what's next. A best gets one quiet line of credit, not praise.",
        `Facts:\n${facts.join("\n")}`,
        `A draft to improve on: ${draft}`,
        "Reply with the note only.",
      ].join("\n\n"),
      timeoutMs,
    );
  }

  /**
   * A nudge when the athlete isn't feeling it (src/nudge.ts), in the coach's words: the same
   * facts, one to three sentences, warm and plain, pushing back when the facts say to. Null: no
   * cloud coach, offline, too slow, or an answer that reads worse than the rules' own.
   */
  async nudgeWords(draft: string, facts: string[], timeoutMs = 8000): Promise<string | null> {
    return this.quickWords(
      [
        `You are the athlete's running coach. ${VOICE_LINE}`,
        "They aren't feeling today's run and asked for a nudge. Write one to three short sentences, at most 240 characters.",
        "Use only these facts; keep their numbers exact; plain warm words; never preachy, no guilt, no greeting, no emoji, no exclamation marks, no lists. When the facts say to lead with the run, say so plainly; when they say to ease off, don't push. End with a small first step (e.g. 10 easy minutes, then decide).",
        `Facts:\n${facts.join("\n")}`,
        `A draft to improve on: ${draft}`,
        "Reply with the nudge only.",
      ].join("\n\n"),
      timeoutMs,
      280,
    );
  }

  /** A short text from the cloud coach, tightly bounded (a few hundred tokens, low thinking, a timeout), or null. */
  private async quickWords(ask: string, timeoutMs: number, maxChars = 260): Promise<string | null> {
    if (typeof navigator !== "undefined" && navigator.onLine === false) return null;
    const s = await this.settings();
    const status = await this.status(TURN);
    // The chat's own provider when it's a cloud one, else the cloud key a phone chat hands to.
    const pick = !ON_PHONE.has(status.provider) && status.ready ? { id: status.provider, model: status.model } : this.cloudPick(s, status.provider, status.providers);
    if (!pick) return null;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((done) => (timer = setTimeout(() => (abort.abort(), done(null)), timeoutMs)));
    const asked = (async (): Promise<string | null> => {
      if (pick.id === "google") {
        const g = await gemini();
        const { ThinkingLevel } = await import("@google/genai");
        const res = await g.geminiClient(this.keyFor(s, "google").key!, this.clientOptions.googleBaseUrl).models.generateContent({
          model: pick.model,
          contents: [{ role: "user", parts: [{ text: ask }] }],
          // A few hundred tokens: a thinking model's short think counts toward it.
          config: { maxOutputTokens: 600, abortSignal: abort.signal, ...(g.thinksInLevels(pick.model) ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } } : {}) },
        });
        return res.text ?? null;
      }
      const res = await (await this.client()).messages.create({ model: pick.model, max_tokens: 160, messages: [{ role: "user", content: ask }] }, { signal: abort.signal });
      return res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    })().catch(() => null);
    const said = await Promise.race([asked, late]).finally(() => clearTimeout(timer));
    const text = said?.replace(/\s+/g, " ").replace(/^["'“]+|["'”]+$/g, "").trim();
    // Anything empty, cut off or long reads worse than the rules' own words.
    return text && text.length >= 20 && text.length <= maxChars && /[.!?]$/.test(text) && !text.includes("!") ? text : null;
  }

  async client(): Promise<Anthropic> {
    const s = await this.settings();
    const { baseURL, fetch, dangerouslyAllowBrowser } = this.clientOptions;
    return new Anthropic({ ...(s.apiKey ? { apiKey: s.apiKey } : {}), baseURL, fetch, dangerouslyAllowBrowser });
  }

  // ------------------------------------------------------------ conversations

  async conversations(): Promise<Array<{ id: string; title: string; updated: string }>> {
    const files = (await this.lib.disk.list("coach/conversations")).map((e) => e.name);
    const out = [];
    for (const f of files.filter((x) => x.endsWith(".json"))) {
      const c = await this.load(f.slice(0, -5));
      if (c) out.push({ id: c.id, title: c.title, updated: c.updated });
    }
    return out.sort((a, b) => b.updated.localeCompare(a.updated));
  }

  async conversation(id: string): Promise<Pick<Conversation, "id" | "title" | "display"> | null> {
    const c = await this.load(id);
    return c ? { id: c.id, title: c.title, display: c.display } : null;
  }

  /**
   * A coach's answer flagged by the athlete (long press → Report reply): marked in the chat, kept
   * in coach/reports.json, and handed back with its question so it can go to Tartan's developer.
   */
  async report(id: string, index: number, reason: string, note?: string): Promise<{ question: string; reply: string; by?: string } | null> {
    const c = await this.load(id);
    const d = c?.display[index];
    if (!c || !d || d.role !== "assistant") return null;
    const why = reason.trim().slice(0, 80) || "Something else";
    d.reported = why;
    await this.save(c);
    const question = c.display.slice(0, index).reverse().find((m) => m.role === "user")?.text ?? "";
    const prior = JSON.parse((await this.lib.disk.readText("coach/reports.json").catch(() => null)) ?? "[]") as unknown[];
    const entry = { at: new Date().toISOString(), conversation: id, index, reason: why, ...(note?.trim() ? { note: note.trim().slice(0, 1000) } : {}), by: d.by, question: question.slice(0, 2000), reply: d.text.slice(0, 4000) };
    await this.lib.disk.write("coach/reports.json", JSON.stringify([...prior, entry].slice(-200)));
    return { question, reply: d.text, ...(d.by ? { by: d.by } : {}) };
  }

  private async load(id: string): Promise<Conversation | null> {
    if (!/^[a-z0-9-]{8,40}$/.test(id)) return null;
    const c = await readJson<Conversation>(this.lib.disk, `coach/conversations/${id}.json`);
    return c ? { ...c, provider: current(c.provider) } : null;
  }

  async save(c: Conversation): Promise<void> {
    if (c.transient) return;
    c.updated = new Date().toISOString();
    await this.lib.disk.write(`coach/conversations/${c.id}.json`, JSON.stringify(c));
  }

  // ------------------------------------------------------------ chat


  /** One user turn: streams text, tool activity and the end state. */
  async *chat(conversationId: string | null, userText: string, opts: ChatOptions = {}): AsyncGenerator<CoachEvent> {
    const text = userText.trim().slice(0, 8000);
    if (!text) return yield { type: "error", message: "Ask something first." };
    const status = await this.status(TURN);

    let conv = conversationId ? await this.load(conversationId) : null;
    // A plan or a review asks for the planner's provider (a cloud key) whatever the chat's is.
    const asked = opts.provider ? status.providers.find((p) => p.id === opts.provider) : undefined;
    if (!conv && asked) {
      if (!asked.keySource) return yield { type: "error", message: `Add your ${COACH_PROVIDERS[asked.id].keyName} in Coach settings first.` };
      const now = new Date().toISOString();
      conv = { id: crypto.randomUUID(), title: (opts.title ?? text).slice(0, 60), created: now, updated: now, model: planModelFor(asked.id, asked.model), provider: asked.id, messages: [], display: [] };
    }
    const notReady = status.provider === "modelhub" ? (status.hub?.notApproved ?? "Model Hub isn't ready: allow Tartan to use it and download a model there (Coach settings).") : `Add your ${COACH_PROVIDERS[status.provider].keyName} in Coach settings first.`;
    if (!conv) {
      if (!status.ready) return yield { type: "error", message: notReady };
      const now = new Date().toISOString();
      // A new chat prepared when its screen opened (prepare) carries on under that id.
      const id = this.nextNewId ?? crypto.randomUUID();
      this.nextNewId = null;
      conv = { id, title: (opts.title ?? text).slice(0, 60), created: now, updated: now, model: status.model, provider: status.provider, messages: [], display: [] };
    }
    // A conversation follows the coach's choice: the plan's own chat the planner, any other the
    // chat's provider (or the one asked for), once that can answer; its history comes along.
    const plan = conversationId ? await this.plans.current() : null;
    const toPlanner = !!opts.provider || (plan?.conversation === conv.id && status.planner.uses !== "rules");
    const want = opts.provider ?? (toPlanner ? (status.planner.uses as Provider) : status.provider);
    const target = status.providers.find((x) => x.id === want);
    if (target?.keySource && (conv.provider ?? "anthropic") !== want) this.rehome(conv, want, toPlanner ? planModelFor(want, target.model) : target.model);
    // A conversation on Gemini Nano (gone since 2.56) that nothing can take over yet: say what to set up.
    if (conv.provider === (GONE_PHONE as string)) return yield { type: "error", message: notReady };
    yield { type: "conversation", id: conv.id, title: conv.title };
    const images = (await this.settings()).photos === false ? [] : (opts.images ?? []).filter(okImage).slice(0, 3);
    this.active = conv;
    this.planSaved = null;
    this.planProposed = 0;
    this.routesShown = [];
    try {
      const p = conv.provider ?? "anthropic";
      // On the phone, a message's words can send it where it's answered best (routeOf).
      const route = ON_PHONE.has(p) && !opts.instructions && !opts.provider ? routeOf(text) : null;
      // Thinking that fits the message: deep for a plan or a review, a quick answer for a question,
      // in the plan's own chat too.
      const effort = effortOf(text, !!opts.provider);
      const turn = ON_PHONE.has(p) ? this.onPhone(conv, text, opts.instructions, images, route) : p === "google" ? this.chatGemini(conv, text, opts.instructions, images, effort) : this.chatClaude(conv, text, opts.instructions, images, effort);
      let told = false;
      for await (const ev of turn) {
        // The plan tab refreshes as soon as the turn ends; a saved plan stays saved even if
        // the closing words fail.
        if ((ev.type === "done" || ev.type === "error") && (this.planSaved || this.planProposed) && !told) {
          told = true;
          yield this.planProposed ? { type: "plan", updated: "", proposed: this.planProposed } : { type: "plan", updated: this.planSaved! };
        }
        const shown = ev.type === "done" || ev.type === "error" ? this.takeRoutes() : [];
        // A route was made but the reply about it failed: say so, not just the error.
        const said = shown.length && ev.type === "error" ? { type: "error" as const, message: `Your route is made and saved: open it below. The coach's reply about it didn't come through (${ev.message.replace(/\.$/, "")}).` } : ev;
        if (shown.length) {
          // Kept with the answer, so the cards are there when the chat is opened again.
          const last = conv.display.findLast((d) => d.role === "assistant");
          if (last) {
            last.routes = [...(last.routes ?? []), ...shown];
            if (said.type === "error" && last.failed) last.error = said.message;
            await this.save(conv);
          }
          for (const c of shown) yield { type: "route", ...c };
        }
        yield said;
      }
    } finally {
      this.active = null;
      this.source = "chat";
    }
  }

  /**
   * A conversation moved to another provider: its history rebuilt from what was shown (the
   * words, not the tool calls), in that API's format; a phone model reads what was shown as it is.
   */
  private rehome(conv: Conversation, to: Provider, model: string): void {
    const said = conv.display.filter((d) => d.text.trim() && !d.failed);
    if (to === "google") conv.contents = said.map((d) => ({ role: d.role === "user" ? "user" : "model", parts: [{ text: d.text }] }));
    if (to === "anthropic") conv.messages = said.map((d) => ({ role: d.role, content: [{ type: "text" as const, text: d.text }] }));
    conv.provider = to;
    conv.model = model;
  }

  /** The cloud provider a phone chat hands to: the planner, else any cloud key (null: none). */
  private async cloudFor(): Promise<{ id: Provider; model: string; label: string; planModel: string; planLabel: string } | null> {
    const status = await this.status(TURN);
    const c = this.cloudPick(await this.settings(), status.provider, status.providers);
    if (!c) return null;
    const planModel = planModelFor(c.id, c.model);
    return { id: c.id, model: c.model, label: modelLabel(c.id, c.model), planModel, planLabel: modelLabel(c.id, planModel) };
  }

  /**
   * A turn in a phone chat. With a cloud key and a connection, the cloud model answers it: it reads
   * every message and decides what to look up or change (a 2B phone model too often misses that a
   * message means "change my plan"); a whole new plan goes to the planner. Offline, without a key,
   * or kept on the phone (phoneOnly), the phone answers, a change nudged to its tools; a new plan
   * still goes to the planner when it can.
   */
  private async *onPhone(conv: Conversation, text: string, instructions: string | undefined, images: ChatImage[], route: ReturnType<typeof routeOf>): AsyncGenerator<CoachEvent> {
    const s = await this.settings();
    const online = typeof navigator === "undefined" || navigator.onLine !== false;
    const cloud = online ? await this.cloudFor() : null;
    const planner = (await this.status(TURN)).planner.uses;
    if (cloud && route?.kind === "plan" && planner !== "rules") {
      if (yield* this.answeredBy(conv, text, images, cloud.planLabel, () => this.planBy(text))) return;
    }
    if (cloud && !s.phoneOnly) {
      if (yield* this.answeredBy(conv, text, images, cloud.label, () => this.cloudTurn(conv, cloud, text, images, instructions))) return;
    }
    yield* this.chatLocal(conv, text, instructions, images, route, cloud);
  }

  /**
   * A phone chat's turn answered elsewhere (`run`): the question and the answer go in this chat.
   * False when nothing came back (offline, say), so the phone answers instead.
   */
  private async *answeredBy(conv: Conversation, text: string, images: ChatImage[], by: string, run: () => AsyncGenerator<CoachEvent>): AsyncGenerator<CoachEvent, boolean> {
    conv.display.push(shown(text, images));
    const reply: Reply = { role: "assistant", text: "", tools: [], by };
    conv.display.push(reply);
    yield { type: "by", label: by };
    let failed: string | null = null;
    try {
      for await (const ev of run()) {
        if (ev.type === "error") failed = ev.message;
        else if (ev.type === "text") reply.text += ev.delta;
        else if (ev.type === "tool") reply.tools.push(ev.label);
        if (ev.type === "text" || ev.type === "tool") yield ev;
      }
    } catch (e) {
      failed = (e as Error).message;
    }
    if (failed && !reply.text) {
      conv.display.splice(-2);
      const label = `Couldn't reach ${by}: answering on your phone`;
      yield { type: "tool", name: "model", label };
      return false;
    }
    if (failed) {
      const note = `\n\n(${failed})`;
      reply.text += note;
      yield { type: "text", delta: note };
    }
    await this.save(conv);
    void this.lib.local.logEvent({ lane: "agent", kind: "coach" });
    yield { type: "done", stop: "end_turn" };
    return true;
  }

  /** A phone chat's question answered by the cloud model with this chat's history; nothing saved but the phone chat. */
  private async *cloudTurn(conv: Conversation, cloud: { id: Provider; model: string; label: string }, text: string, images: ChatImage[], instructions?: string): AsyncGenerator<CoachEvent> {
    const now = new Date().toISOString();
    // The phone chat's id: a plan saved from here belongs to this chat.
    const temp: Conversation = { id: conv.id, title: conv.title, created: now, updated: now, model: cloud.model, provider: cloud.id, messages: [], display: conv.display.slice(0, -2).filter((d) => !d.failed).map((d) => ({ ...d })), transient: true };
    this.rehome(temp, cloud.id, cloud.model);
    const outer = this.active;
    this.active = temp;
    try {
      yield* cloud.id === "google" ? this.chatGemini(temp, text, instructions, images, effortOf(text)) : this.chatClaude(temp, text, instructions, images, effortOf(text));
    } finally {
      this.active = outer;
    }
  }

  /** A plan change from a phone chat, by the planner, its words as they come (the plan's own conversation keeps them too). */
  async *planBy(request: string): AsyncGenerator<CoachEvent> {
    const outer = this.active;
    try {
      yield* this.updatePlan(request, undefined, { fromChat: true });
    } finally {
      this.active = outer;
    }
  }






  /**
   * Make or remake the training plan: a fresh conversation (the plan tab's "Update plan")
   * whose instructions name the dates and the time available, so the coach plans from today.
   */
  async *updatePlan(note?: string, target?: string, o: { fromChat?: boolean } = {}): AsyncGenerator<CoachEvent> {
    // Written by the planner (a cloud key); without one, by Tartan's rules, explained on the phone.
    const planner = await this.planner();
    if (planner === "rules") return yield* this.planOnDevice(target);
    const analytics = new Analytics(this.lib);
    const [goals, current] = await Promise.all([analytics.goalProgress(), this.plans.current()]);
    const t = today();
    const monday = mondayOf(t);
    const race = goals.race?.date && goals.race.days_to_go !== undefined && goals.race.days_to_go >= 0 ? goals.race : null;
    // The length comes from the target date alone (the model reads it: "end of March", "14/3");
    // without one, 8 weeks. Free text elsewhere doesn't change it.
    const until = target?.trim().slice(0, 80);
    const length = until
      ? `Plan up to my target date: "${until}". Work out the calendar date it means, set target_date to it, and plan every week from Monday ${monday} through the week that contains it (at most 26 weeks; if it is further away, plan 26 weeks and say so). If you can't read it as a date, plan 8 weeks and say so.`
      : o.fromChat
        ? `If my message below names a race or a target date, plan every week from Monday ${monday} through the week that contains it (at most 26 weeks), with target_date set to it; otherwise plan 8 weeks without a target_date. If it changes only a session or two, keep the rest of the plan as it is.`
        : `Plan exactly 8 weeks (8 entries in weeks), without a target_date.`;
    const raceNote = race ? `My race: ${race.name ?? "a race"}, ${num1(race.distance_km)} km on ${race.date}${race.target_s ? `, target time ${Math.floor(race.target_s / 60)} min` : ""}.` : "";
    const a = goals.goals.availability;
    const time = a?.days_per_week || a?.hours_per_week
      ? `I have ${[a.days_per_week ? `${a.days_per_week} days` : "", a.hours_per_week ? `about ${a.hours_per_week} hours` : ""].filter(Boolean).join(" and ")} a week for training${a.long_run_day ? `, long run on ${a.long_run_day}` : ""}.`
      : "I haven't said how much time I have: plan around what I actually did in the last four weeks.";
    const asked = (note?.trim() ? note.trim().slice(0, 600) : "") || (current ? "Update my training plan." : "Make me a training plan.");
    const instructions = [
      `Write my training plan now with save_training_plan${current ? `, replacing the current one (last updated ${current.updated.slice(0, 10)}); I'll accept the changes on the Coach tab` : ""}.`,
      `This comes from the Plan tab: don't ask questions now; assume sensibly and name your assumptions.`,
      `Today is ${t}. Start with the week of Monday ${monday}. ${length}${o.fromChat ? "" : " Lengths mentioned in my message below don't change this."} Leave this week's days before today as they were in the current plan, or out if there was none.`,
      raceNote,
      time,
      a?.notes ? `My notes: ${a.notes}` : "",
    ].filter(Boolean).join("\n");
    this.source = current ? "update" : "chat";
    yield* this.chat(null, asked, { title: `Training plan, ${t}`, instructions, provider: planner });
  }
  /**
   * The weekly review: in the plan's own conversation, the coach looks back at the week (what
   * was done or missed, how the structured sessions went, readiness, load) and changes the
   * coming week when it should, saving the whole plan; otherwise it leaves the plan alone.
   */
  async *weeklyReview(week: string): AsyncGenerator<CoachEvent> {
    const current = await this.plans.current();
    if (!current) return yield { type: "error", message: "No plan to review." };
    const planner = await this.planner();
    if (planner === "rules") {
      const instructions = `Weekly review for the week before Monday ${week}: from the plan (done, missed) and readiness, say in two or three short sentences, without lists, what last week showed and what to keep in mind for the coming week. You can't change the plan.`;
      this.source = "weekly";
      return yield* this.chat(current.conversation ?? null, "How did my week go?", { title: `Weekly review, ${week}`, instructions });
    }
    const instructions = [
      `Weekly review for the week starting Monday ${week}. Nobody is waiting on this: don't ask questions.`,
      `Look back with get_training_plan (done, missed, marked by hand), review_session for the structured sessions done since last Monday, get_readiness and get_training_load.`,
      `Then decide whether the coming week (from Monday ${week}) should change: missed key sessions, sessions run too hard or too easy against their targets, high fatigue or poor readiness, or a big week done well. If it should, save the whole plan with save_training_plan, keeping past days as they were and changing only what the change needs, with change_note and each changed session's why from the data; the athlete accepts it on the Coach tab. If not, don't save.`,
      `If the week taught something lasting about the athlete (how they take a hard week, a niggle that keeps coming back, when they really train), keep it with remember or update_memory.`,
      `Answer in two or three short sentences, without lists: what last week showed, and what you suggest for the coming week and why (or that it stays as planned).`,
    ].join("\n");
    this.source = "weekly";
    // In the plan's own conversation when the planner wrote it there; else a new one on the planner.
    const planConv = current.conversation ? await this.load(current.conversation) : null;
    const conv = planConv?.provider === planner ? planConv.id : null;
    yield* this.chat(conv, "How did my week go? Adjust next week if it needs it.", { title: `Weekly review, ${week}`, instructions, provider: planner });
  }



  /**
   * Get the chat ready while its screen is open (Model Hub's prepare): Model Hub loads the model
   * and reads the instructions, tools and chat now, so the first question only reads its own
   * words. Only on Model Hub, and only for a chat that will run there; null otherwise. A new chat
   * gets its id now, and keeps it when its first question comes (nextNewId).
   */
  async prepare(conversationId: string | null): Promise<string | null> {
    const hub = this.clientOptions.modelHub;
    if (!hub) return null;
    const conv = conversationId ? await this.load(conversationId) : null;
    const state = await this.hubState(TURN.hubAge);
    const status = await this.status(TURN);
    // Where the chat's next question goes (chat() moves it there): the plan's chat to the planner.
    const plan = conv ? await this.plans.current() : null;
    const provider = plan?.conversation === conv?.id && status.planner.uses !== "rules" ? status.planner.uses : status.provider;
    if (provider !== "modelhub" || !hubReady(state)) return null;
    // The cloud model answers this chat (online, with a key): nothing to get ready on the phone.
    const online = typeof navigator === "undefined" || navigator.onLine !== false;
    if (online && !(await this.settings()).phoneOnly && (await this.cloudFor())) return null;
    const id = conv?.id ?? (this.nextNewId ??= crypto.randomUUID());
    await prepareLocal({ model: hub, tools: [...this.tools, this.editSessionTool(), this.changePlanTool()], system: await this.localSystem(), history: conv ? localHistory(conv) : [], id, turns: conv?.display.length ?? 0, context: state!.context });
    return id;
  }

  // ------------------------------------------------------------ moved to src/coach/ (kept here as the class's own)

  private chatGemini(conv: Conversation, text: string, instructions?: string, images: ChatImage[] = [], effort: Effort = "low"): AsyncGenerator<CoachEvent> {
    return chatGemini(this, conv, text, instructions, images, effort);
  }
  private chatClaude(conv: Conversation, text: string, instructions?: string, images: ChatImage[] = [], effort: Effort = "medium"): AsyncGenerator<CoachEvent> {
    return chatClaude(this, conv, text, instructions, images, effort);
  }
  private chatLocal(conv: Conversation, text: string, instructions?: string, images: ChatImage[] = [], route: ReturnType<typeof routeOf> = null, cloud: CloudPick | null = null): AsyncGenerator<CoachEvent> {
    return chatLocal(this, conv, text, instructions, images, route, cloud);
  }
  localSystem(instructions?: string): Promise<string> {
    return localSystem(this, instructions);
  }
  rulesReplan(until?: string): Promise<Record<string, unknown>> {
    return rulesReplan(this, until);
  }
  editSessionTool(): DataTool {
    return editSessionTool(this);
  }
  changePlanTool(): DataTool {
    return changePlanTool(this);
  }
  private planOnDevice(target?: string): AsyncGenerator<CoachEvent> {
    return planOnDevice(this, target);
  }
}
