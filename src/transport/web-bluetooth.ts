/**
 * Browser transport: Web Bluetooth (Chrome/Edge on desktop and Android).
 * The OS handles bonding: Chrome triggers pairing when the watch demands encryption.
 */
import { WB_NOTIFY, WB_SERVICE, WB_WRITE, type BleLink } from "../protocol/session.ts";

export interface WebDeviceInfo {
  battery?: number;
  model?: string;
  firmware?: string;
  manufacturer?: string;
}

export class WebBluetoothLink implements BleLink {
  private constructor(
    private readonly device: BluetoothDevice,
    private readonly writer: BluetoothRemoteGATTCharacteristic,
    private readonly notifier: BluetoothRemoteGATTCharacteristic,
    readonly chunkSize: number,
    readonly extra: WebDeviceInfo,
  ) {}

  get name(): string {
    return this.device.name ?? "Suunto watch";
  }

  static supported(): boolean {
    return typeof navigator !== "undefined" && !!navigator.bluetooth;
  }

  /**
   * Shows the browser's device chooser. Must be called from a user gesture (click).
   * `chunkSize` above 20 needs a negotiated MTU; 20 always works.
   */
  static async request(opts: { chunkSize?: number; acceptAll?: boolean } = {}): Promise<WebBluetoothLink> {
    const optionalServices = [WB_SERVICE, "battery_service", "device_information"];
    const device = await navigator.bluetooth.requestDevice(
      opts.acceptAll
        ? { acceptAllDevices: true, optionalServices }
        : { filters: [{ namePrefix: "Suunto" }, { services: [WB_SERVICE] }], optionalServices },
    );
    if (!device.gatt) throw new Error("this device has no GATT server");
    const server = await device.gatt.connect();
    let service: BluetoothRemoteGATTService;
    try {
      service = await server.getPrimaryService(WB_SERVICE);
    } catch {
      throw new Error("whiteboard service not found — is this a SuuntoPlus-generation watch, and is the phone's Bluetooth off?");
    }
    const writer = await service.getCharacteristic(WB_WRITE);
    const notifier = await service.getCharacteristic(WB_NOTIFY);
    const extra = await readStandardInfo(server);
    return new WebBluetoothLink(device, writer, notifier, opts.chunkSize ?? 20, extra);
  }

  async subscribe(onData: (chunk: Uint8Array) => void, onClose: (reason: string) => void): Promise<void> {
    this.notifier.addEventListener("characteristicvaluechanged", (ev) => {
      const v = (ev.target as BluetoothRemoteGATTCharacteristic).value;
      if (v) onData(new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice());
    });
    this.device.addEventListener("gattserverdisconnected", () => onClose("watch disconnected"));
    await this.notifier.startNotifications();
  }

  async write(chunk: Uint8Array): Promise<void> {
    await this.writer.writeValueWithoutResponse(chunk.slice());
  }

  async close(): Promise<void> {
    try {
      await this.notifier.stopNotifications();
    } catch {
      // already gone
    }
    this.device.gatt?.disconnect();
  }
}

/** Standard GATT services (battery, device information), when the watch exposes them. */
async function readStandardInfo(server: BluetoothRemoteGATTServer): Promise<WebDeviceInfo> {
  const info: WebDeviceInfo = {};
  const text = (v: DataView) => new TextDecoder().decode(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
  try {
    const bat = await server.getPrimaryService("battery_service");
    info.battery = (await (await bat.getCharacteristic("battery_level")).readValue()).getUint8(0);
  } catch {
    // not exposed
  }
  try {
    const dis = await server.getPrimaryService("device_information");
    const read = async (c: string) => text(await (await dis.getCharacteristic(c)).readValue());
    info.model = await read("model_number_string").catch(() => undefined);
    info.firmware = await read("firmware_revision_string").catch(() => undefined);
    info.manufacturer = await read("manufacturer_name_string").catch(() => undefined);
  } catch {
    // not exposed
  }
  return info;
}
