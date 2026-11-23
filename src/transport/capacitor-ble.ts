/**
 * Android (and iOS) transport for the native app: @capacitor-community/bluetooth-le.
 *
 * A watch that is already paired with the phone (through the Suunto app) is used as is: the
 * pairing belongs to Android, not to an app, so Tartan connects to it directly with no
 * picker and no code. Only an unpaired watch goes through the picker and Android's
 * 6-digit-code dialog.
 */
import { BleClient, ConnectionPriority, type BleDevice } from "@capacitor-community/bluetooth-le";
import { WB_NOTIFY, WB_SERVICE, WB_WRITE, type BleLink } from "../protocol/session.ts";
import { brandOf, companiesOf, type FoundWatch } from "./brand.ts";

const LAST_WATCH = "freesuunto.watch";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isSuunto = (d: BleDevice) => /suunto/i.test(d.name ?? "");

/** The Suunto watch Android already has a pairing for: the last one used, else the only one. */
async function pairedWatch(): Promise<BleDevice | null> {
  const bonded = (await BleClient.getBondedDevices().catch(() => [] as BleDevice[])).filter(isSuunto);
  const last = localStorage.getItem(LAST_WATCH);
  return bonded.find((d) => d.deviceId === last) ?? (bonded.length === 1 ? bonded[0]! : null);
}

/** The Suunto watch this phone has paired (the last one used, else the only one), as Find my watch counts it. */
export async function pairedSuunto(): Promise<FoundWatch | null> {
  await BleClient.initialize({ androidNeverForLocation: true }).catch(() => {});
  const d = await pairedWatch().catch(() => null);
  return d ? { brand: "suunto", name: d.name ?? "Suunto watch", id: d.deviceId, via: "paired" } : null;
}

/**
 * Watches advertising nearby for a few seconds, each with its brand (src/transport/brand.ts: the
 * company id in its manufacturer data, else its name); anything that isn't a Suunto or a Garmin
 * is left out. Call it from a tap: it asks for Bluetooth (and turning it on) first.
 */
export async function scanWatches(ms = 6000): Promise<FoundWatch[]> {
  await BleClient.initialize({ androidNeverForLocation: true });
  if (!(await BleClient.isEnabled())) await BleClient.requestEnable().catch(() => {});
  const seen = new Map<string, FoundWatch>();
  await BleClient.requestLEScan({ allowDuplicates: false }, (r) => {
    const name = r.localName ?? r.device.name ?? "";
    const brand = brandOf({ companies: companiesOf(r.manufacturerData), name });
    if (!brand) return;
    const was = seen.get(r.device.deviceId);
    seen.set(r.device.deviceId, { brand, name: name || was?.name || (brand === "garmin" ? "Garmin watch" : "Suunto watch"), id: r.device.deviceId, via: "nearby", rssi: Math.max(r.rssi ?? -127, was?.rssi ?? -127) });
  });
  await sleep(ms);
  await BleClient.stopLEScan().catch(() => {});
  return [...seen.values()];
}

export class CapacitorBleLink implements BleLink {
  private onClose: ((reason: string) => void) | null = null;

  private constructor(
    private readonly deviceId: string,
    readonly name: string,
    readonly chunkSize: number,
    private readonly log: (m: string) => void,
  ) {}

  /** A watch Tartan connected to before, which Android still has paired. */
  static async knowsPairedWatch(): Promise<boolean> {
    if (!localStorage.getItem(LAST_WATCH)) return false;
    await BleClient.initialize({ androidNeverForLocation: true }).catch(() => {});
    return !!(await pairedWatch());
  }

  /**
   * Connects to the paired watch, or shows the system picker and pairs (call that from a tap).
   * `pairedOnly` never shows the picker: it fails instead when no paired watch is known.
   */
  static async request(log: (m: string) => void = () => {}, opts: { pairedOnly?: boolean; deviceId?: string; name?: string } = {}): Promise<CapacitorBleLink> {
    await BleClient.initialize({ androidNeverForLocation: true });
    if (!(await BleClient.isEnabled())) {
      if (opts.pairedOnly) throw new Error("Bluetooth is off");
      await BleClient.requestEnable().catch(() => {});
    }
    // A watch Find my watch picked (src/transport/brand.ts): that one, paired or not.
    const picked: BleDevice | null = opts.deviceId ? { deviceId: opts.deviceId, ...(opts.name ? { name: opts.name } : {}) } : null;
    const paired = picked ? null : await pairedWatch();
    if (!picked && !paired && opts.pairedOnly) throw new Error("no paired watch");
    const device = picked ?? paired ?? (await BleClient.requestDevice({ namePrefix: "Suunto", optionalServices: [WB_SERVICE] }));
    const name = device.name ?? "Suunto watch";
    if (paired) log(`${name} is already paired with this phone; connecting directly.`);

    let link: CapacitorBleLink | null = null;
    // The watch drops unbonded centrals during service discovery, so bond first.
    try {
      if (!(await BleClient.isBonded(device.deviceId))) {
        log("Pairing — enter the code shown on the watch when Android asks.");
        await BleClient.createBond(device.deviceId, { timeout: 60_000 });
      }
    } catch (e) {
      // isBonded/createBond are Android-only; on iOS the OS pairs during connect.
      if (!/not available|unavailable|implemented/i.test(String((e as Error).message))) throw e;
    }
    try {
      await BleClient.connect(device.deviceId, () => link?.onClose?.("watch disconnected"), { timeout: 20_000 });
    } catch (e) {
      if (!paired) throw e;
      throw new Error(`Couldn't reach ${name}. Wake the watch and keep it near the phone. If the Suunto app is syncing it right now, wait for that to finish, or close the Suunto app, and try again. (${(e as Error).message})`);
    }
    localStorage.setItem(LAST_WATCH, device.deviceId);
    await BleClient.requestConnectionPriority(device.deviceId, ConnectionPriority.CONNECTION_PRIORITY_HIGH).catch(() => {});
    const mtu = await BleClient.getMtu(device.deviceId).catch(() => 23);
    log(`Connected to ${name}, MTU ${mtu}`);
    link = new CapacitorBleLink(device.deviceId, name, Math.max(20, mtu - 3), log);
    return link;
  }

  async subscribe(onData: (chunk: Uint8Array) => void, onClose: (reason: string) => void): Promise<void> {
    this.onClose = onClose;
    const start = () =>
      BleClient.startNotifications(this.deviceId, WB_SERVICE, WB_NOTIFY, (v: DataView) => {
        onData(new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice());
      });
    const missing = (e: unknown) => /(characteristic|service) not found/i.test(String((e as Error)?.message ?? e));
    try {
      return await start();
    } catch (e) {
      if (!missing(e)) throw e;
    }
    // Android sometimes hands over an incomplete or stale copy of the watch's services
    // (after a Bluetooth restart, or while another app is mid-sync): read them again.
    const seen = await BleClient.getServices(this.deviceId).catch(() => []);
    this.log(`The watch's data service wasn't in what Android found (${seen.map((x) => x.uuid.slice(0, 8)).join(", ") || "no services"}); asking again…`);
    await BleClient.discoverServices(this.deviceId).catch((e) => this.log(`Service discovery failed: ${(e as Error).message}`));
    await sleep(600);
    try {
      return await start();
    } catch (e) {
      if (!missing(e)) throw e;
    }
    this.log("Still missing; reconnecting once…");
    await BleClient.disconnect(this.deviceId).catch(() => {});
    await sleep(1500);
    await BleClient.connect(this.deviceId, () => this.onClose?.("watch disconnected"), { timeout: 20_000 });
    await BleClient.discoverServices(this.deviceId).catch(() => {});
    await sleep(600);
    try {
      await start();
    } catch (e) {
      if (!missing(e)) throw e;
      const again = await BleClient.getServices(this.deviceId).catch(() => []);
      throw new Error(
        `the watch didn't offer its data service (Android found: ${again.map((x) => x.uuid.slice(0, 8)).join(", ") || "nothing"}). Turn Bluetooth off and on, wake the watch, and try again; if it persists, restart the watch.`,
      );
    }
  }

  async write(chunk: Uint8Array): Promise<void> {
    const copy = chunk.slice();
    await BleClient.writeWithoutResponse(this.deviceId, WB_SERVICE, WB_WRITE, new DataView(copy.buffer));
  }

  async close(): Promise<void> {
    this.onClose = null;
    await BleClient.stopNotifications(this.deviceId, WB_SERVICE, WB_NOTIFY).catch(() => {});
    await BleClient.disconnect(this.deviceId).catch(() => {});
  }
}
