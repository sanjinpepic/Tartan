/**
 * Linux transport: BlueZ over D-Bus (no native addons, works under Bun).
 *
 * Finds the watch by advertised name (it rotates its private address and hands out no
 * IRK, so addresses are unreliable), connects, and exposes the whiteboard
 * characteristics as a BleLink. Also does the one-time bonding with a passkey agent.
 */
import dbus, { Variant, type MessageBus, type ProxyObject } from "dbus-next";
import { WB_NOTIFY, WB_SERVICE, WB_WRITE, type BleLink } from "../protocol/session.ts";

const BLUEZ = "org.bluez";
const I_ADAPTER = "org.bluez.Adapter1";
const I_DEVICE = "org.bluez.Device1";
const I_CHAR = "org.bluez.GattCharacteristic1";
const I_PROPS = "org.freedesktop.DBus.Properties";
const I_OM = "org.freedesktop.DBus.ObjectManager";
const AGENT_PATH = "/tartan/agent";

type Props = Record<string, Variant>;
/** dbus-next proxies are dynamic; methods are looked up by name at runtime. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ClientInterface = { [method: string]: any; on(event: string, fn: (...args: any[]) => void): void };
const iface = (obj: ProxyObject, name: string): ClientInterface => obj.getInterface(name) as unknown as ClientInterface;
type Managed = Record<string, Record<string, Props>>;

export interface Candidate {
  path: string;
  address: string;
  name: string;
  rssi?: number;
  paired: boolean;
}

export interface FindOptions {
  /** Substring of the advertised name (model + serial), case-insensitive. */
  needle?: string;
  /** Bluetooth address; works only while the watch advertises its identity address. */
  address?: string;
  scanMs?: number;
  log?: (m: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const val = <T>(p: Props | undefined, k: string): T | undefined => p?.[k]?.value as T | undefined;

export class Bluez {
  private constructor(readonly bus: MessageBus, private readonly om: ClientInterface, readonly adapterPath: string) {}

  static async connect(adapter?: string): Promise<Bluez> {
    const bus = dbus.systemBus();
    let root: ProxyObject;
    try {
      root = await bus.getProxyObject(BLUEZ, "/");
    } catch (e) {
      bus.disconnect();
      throw new Error(`BlueZ is not reachable on the system D-Bus (${(e as Error).message}). Is bluetoothd running?`);
    }
    const om = iface(root, I_OM);
    const objects = (await om.GetManagedObjects()) as Managed;
    const adapters = Object.keys(objects).filter((p) => objects[p]![I_ADAPTER]);
    const path = adapter ? adapters.find((p) => p.endsWith("/" + adapter)) : adapters[0];
    if (!path) {
      bus.disconnect();
      throw new Error(adapter ? `no Bluetooth adapter named ${adapter}` : "no Bluetooth adapter found");
    }
    return new Bluez(bus, om, path);
  }

  close(): void {
    this.bus.disconnect();
  }

  async objects(): Promise<Managed> {
    return (await this.om.GetManagedObjects()) as Managed;
  }

  private async adapter(): Promise<ClientInterface> {
    return iface(await this.bus.getProxyObject(BLUEZ, this.adapterPath), I_ADAPTER);
  }

  /** Devices that look like a Suunto watch (by name or cached service UUID). */
  async candidates(opts: FindOptions = {}, onlySeen = false): Promise<Candidate[]> {
    const objects = await this.objects();
    const out: Candidate[] = [];
    for (const [path, ifaces] of Object.entries(objects)) {
      const d = ifaces[I_DEVICE];
      if (!d || !path.startsWith(this.adapterPath + "/")) continue;
      const name = val<string>(d, "Name") ?? val<string>(d, "Alias") ?? "";
      const address = val<string>(d, "Address") ?? "";
      const rssi = val<number>(d, "RSSI");
      const uuids = val<string[]>(d, "UUIDs") ?? [];
      const byAddr = !!opts.address && address.toLowerCase() === opts.address.toLowerCase();
      const looksRight = /suunto/i.test(name) || uuids.some((u) => u.toLowerCase() === WB_SERVICE);
      if (!byAddr && !looksRight) continue;
      if (opts.needle && !byAddr && !name.toLowerCase().replace(/\s+/g, "").includes(opts.needle.toLowerCase().replace(/\s+/g, ""))) continue;
      if (onlySeen && rssi === undefined && !val<boolean>(d, "Connected")) continue;
      out.push({ path, address, name, rssi, paired: !!val<boolean>(d, "Paired") });
    }
    return out;
  }

  /**
   * Scan until a matching watch advertises, then stop at once: the watch only advertises
   * in short windows and latency between sighting and connecting matters.
   */
  async find(opts: FindOptions = {}, keepScanning = false): Promise<Candidate> {
    const log = opts.log ?? (() => {});
    const adapter = await this.adapter();
    await adapter.SetDiscoveryFilter({ Transport: new Variant("s", "le") }).catch(() => {});
    let started = false;
    try {
      await adapter.StartDiscovery();
      started = true;
    } catch (e) {
      log(`[scan] could not start discovery (${(e as Error).message}); looking at known devices only`);
    }
    const deadline = Date.now() + (opts.scanMs ?? 20_000);
    try {
      for (;;) {
        // While discovering, RSSI is present only on devices seen in this scan.
        const seen = await this.candidates(opts, started);
        if (seen.length > 1 && !opts.needle && !opts.address) {
          throw new Error(
            "several watches in range; pick one with --needle <part of the name>:\n" +
              seen.map((c) => `  ${c.name}  ${c.address}  RSSI ${c.rssi ?? "?"}`).join("\n"),
          );
        }
        if (seen[0]) {
          log(`[scan] found ${seen[0].name} @ ${seen[0].address} (RSSI ${seen[0].rssi ?? "?"})`);
          return seen[0];
        }
        if (Date.now() > deadline) {
          throw new Error(
            "no watch found. Wake the watch (open Settings → Connectivity), turn the phone's Bluetooth off, close desktop Bluetooth panels.",
          );
        }
        await sleep(400);
      }
    } finally {
      if (started && !keepScanning) {
        await adapter.StopDiscovery().catch(() => {});
        await sleep(400); // let BlueZ finish tearing discovery down before connecting
      }
    }
  }

  async stopDiscovery(): Promise<void> {
    await (await this.adapter()).StopDiscovery().catch(() => {});
  }

  /** One-time bonding. The watch shows a 6-digit code; `askPasskey` must return it. */
  async pair(opts: FindOptions & { askPasskey: () => Promise<string> }): Promise<Candidate> {
    const log = opts.log ?? (() => {});
    // The watch keeps a single bond slot, so an old host bond is dead once the phone paired.
    for (const old of (await this.candidates(opts)).filter((c) => c.paired)) {
      log(`[pair] removing the old bond with ${old.name} first`);
      await (await this.adapter()).RemoveDevice(old.path).catch(() => {});
    }
    const agent = new PasskeyAgent(opts.askPasskey, log);
    this.bus.export(AGENT_PATH, agent);
    const manager = iface(await this.bus.getProxyObject(BLUEZ, "/org/bluez"), "org.bluez.AgentManager1");
    await manager.RegisterAgent(AGENT_PATH, "KeyboardOnly");
    await manager.RequestDefaultAgent(AGENT_PATH).catch(() => {});
    try {
      // Never stop scanning before Pair(): BlueZ drops unbonded devices when discovery ends.
      const found = await this.find(opts, true);
      const obj = await this.bus.getProxyObject(BLUEZ, found.path);
      log("[pair] pairing — a 6-digit code should pop up on the watch…");
      let lastErr: unknown;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await iface(obj, I_DEVICE).Pair();
          lastErr = undefined;
          break;
        } catch (e) {
          lastErr = e;
          // A cached sighting can answer "not available" seconds before the live one arrives.
          if (!/not available|InProgress/i.test(String((e as Error).message))) break;
          await sleep(1500);
        }
      }
      if (lastErr) throw lastErr;
      await iface(obj, I_PROPS).Set(I_DEVICE, "Trusted", new Variant("b", true));
      log("[pair] bonded and trusted.");
      return { ...found, paired: true };
    } finally {
      await this.stopDiscovery();
      await manager.UnregisterAgent(AGENT_PATH).catch(() => {});
      this.bus.unexport(AGENT_PATH, agent);
    }
  }

  /** Remove the bond (e.g. before going back to the phone app). */
  async forget(opts: FindOptions): Promise<Candidate[]> {
    const gone = await this.candidates(opts);
    for (const c of gone) await (await this.adapter()).RemoveDevice(c.path).catch(() => {});
    return gone;
  }

  async open(opts: FindOptions = {}): Promise<BluezLink> {
    const log = opts.log ?? (() => {});
    const found = await this.find(opts);
    if (!found.paired) log("[connect] warning: this watch is not bonded with this computer yet — run `tartan pair` first");
    return BluezLink.connect(this, found, log);
  }
}

/** org.bluez.Agent1 that asks the user for the passkey shown on the watch. */
class PasskeyAgent extends dbus.interface.Interface {
  constructor(private readonly ask: () => Promise<string>, private readonly log: (m: string) => void) {
    super("org.bluez.Agent1");
  }
  Release(): void {}
  async RequestPasskey(_device: string): Promise<number> {
    const code = (await this.ask()).trim();
    if (!/^\d{1,6}$/.test(code)) throw new dbus.DBusError("org.bluez.Error.Rejected", "passkey must be 6 digits");
    return Number(code);
  }
  async RequestPinCode(_device: string): Promise<string> {
    return (await this.ask()).trim();
  }
  DisplayPasskey(_device: string, passkey: number): void {
    this.log(`[pair] passkey ${String(passkey).padStart(6, "0")} — confirm it on the watch`);
  }
  DisplayPinCode(_device: string, pin: string): void {
    this.log(`[pair] PIN ${pin}`);
  }
  RequestConfirmation(_device: string, passkey: number): void {
    this.log(`[pair] confirming passkey ${String(passkey).padStart(6, "0")}`);
  }
  RequestAuthorization(_device: string): void {}
  AuthorizeService(_device: string, _uuid: string): void {}
  Cancel(): void {
    this.log("[pair] cancelled by BlueZ");
  }
}
PasskeyAgent.configureMembers({
  methods: {
    Release: {},
    RequestPasskey: { inSignature: "o", outSignature: "u" },
    RequestPinCode: { inSignature: "o", outSignature: "s" },
    DisplayPasskey: { inSignature: "ouq" },
    DisplayPinCode: { inSignature: "os" },
    RequestConfirmation: { inSignature: "ou" },
    RequestAuthorization: { inSignature: "o" },
    AuthorizeService: { inSignature: "os" },
    Cancel: {},
  },
});

export class BluezLink implements BleLink {
  private closed = false;
  private onClose: ((reason: string) => void) | null = null;

  private constructor(
    private readonly bz: Bluez,
    private readonly device: ClientInterface,
    private readonly writer: ClientInterface,
    private readonly notifyObj: ProxyObject,
    readonly name: string,
    readonly chunkSize: number,
    readonly battery: number | undefined,
  ) {}

  static async connect(bz: Bluez, found: Candidate, log: (m: string) => void): Promise<BluezLink> {
    const obj = await bz.bus.getProxyObject(BLUEZ, found.path);
    const device = iface(obj, I_DEVICE);
    const props = iface(obj, I_PROPS);
    log(`[connect] connecting to ${found.name}…`);
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await device.Connect();
        lastErr = undefined;
        break;
      } catch (e) {
        lastErr = e;
        log(`[connect] attempt ${attempt} failed: ${(e as Error).message}`);
        await sleep(1000);
      }
    }
    if (lastErr) {
      throw new Error(
        `could not connect (${(lastErr as Error).message}). If this keeps happening the bond is probably dead ` +
          "(pairing the phone evicts it): run `tartan pair` again.",
      );
    }

    // Wait for GATT discovery.
    const deadline = Date.now() + 20_000;
    while (!((await props.Get(I_DEVICE, "ServicesResolved")) as Variant<boolean>).value) {
      if (Date.now() > deadline) throw new Error("GATT service discovery timed out (is the watch bonded?)");
      await sleep(200);
    }

    const objects = await bz.objects();
    const chars = Object.entries(objects).filter(([p, i]) => p.startsWith(found.path + "/") && i[I_CHAR]);
    const byUuid = (u: string) => chars.find(([, i]) => val<string>(i[I_CHAR], "UUID")?.toLowerCase() === u)?.[0];
    const writePath = byUuid(WB_WRITE);
    const notifyPath = byUuid(WB_NOTIFY);
    if (!writePath || !notifyPath) {
      throw new Error(`the device has no whiteboard service (${WB_SERVICE}); is this a SuuntoPlus-generation watch?`);
    }
    const writeObj = await bz.bus.getProxyObject(BLUEZ, writePath);
    const notifyObj = await bz.bus.getProxyObject(BLUEZ, notifyPath);
    const mtu = val<number>(objects[writePath]![I_CHAR], "MTU");
    const chunk = mtu && mtu > 23 ? mtu - 3 : 20;
    const batteryPct = val<number>(objects[found.path]!["org.bluez.Battery1"], "Percentage");
    log(`[connect] connected, ATT MTU ${mtu ?? "unknown"} → ${chunk}-byte writes${batteryPct !== undefined ? `, battery ${batteryPct}%` : ""}`);

    const link = new BluezLink(bz, device, iface(writeObj, I_CHAR), notifyObj, found.name, chunk, batteryPct);
    props.on("PropertiesChanged", (ifaceName: string, changed: Props) => {
      if (ifaceName === I_DEVICE && changed.Connected && changed.Connected.value === false) link.fail("watch disconnected");
    });
    return link;
  }

  private fail(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose?.(reason);
  }

  async subscribe(onData: (chunk: Uint8Array) => void, onClose: (reason: string) => void): Promise<void> {
    this.onClose = onClose;
    iface(this.notifyObj, I_PROPS).on("PropertiesChanged", (ifaceName: string, changed: Props) => {
      if (ifaceName === I_CHAR && changed.Value) onData(new Uint8Array(changed.Value.value as Buffer));
    });
    await iface(this.notifyObj, I_CHAR).StartNotify();
  }

  async write(chunk: Uint8Array): Promise<void> {
    await this.writer.WriteValue(Buffer.from(chunk), { type: new Variant("s", "command") });
  }

  async close(): Promise<void> {
    this.closed = true;
    await iface(this.notifyObj, I_CHAR).StopNotify().catch(() => {});
    await this.device.Disconnect().catch(() => {});
    this.bz.close();
  }
}
