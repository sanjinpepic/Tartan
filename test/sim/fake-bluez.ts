/**
 * A minimal org.bluez look-alike for tests: one adapter, one Suunto watch whose GATT
 * whiteboard characteristics are backed by the protocol simulator in fake-watch.ts.
 * Runs on a private dbus-daemon; point DBUS_SYSTEM_BUS_ADDRESS at it.
 */
import dbus, { Variant, type MessageBus } from "dbus-next";
import { WB_NOTIFY, WB_SERVICE, WB_WRITE } from "../../src/protocol/session.ts";
import { FakeWatch, type FakeWatchOptions } from "../../src/sim/fake-watch.ts";

const { Interface } = dbus.interface;
type AnyIface = InstanceType<typeof Interface>;

export const ADAPTER = "/org/bluez/hci0";
export const DEVICE = `${ADAPTER}/dev_C0_FF_EE_00_00_42`;
const SERVICE = `${DEVICE}/service0010`;
const WRITE_CHAR = `${SERVICE}/char0011`;
const NOTIFY_CHAR = `${SERVICE}/char0013`;

export interface FakeBluezState {
  discovering: boolean;
  paired: boolean;
  trusted: boolean;
  connected: boolean;
  passkeyEntered?: number;
}

export async function startFakeBluez(opts: FakeWatchOptions & { passkey?: string; mtu?: number }) {
  const bus: MessageBus = dbus.sessionBus({ busAddress: process.env.DBUS_SYSTEM_BUS_ADDRESS! } as never);
  const state: FakeBluezState = { discovering: false, paired: false, trusted: false, connected: false };
  const mtu = opts.mtu ?? 247;
  let watch = new FakeWatch({ ...opts, name: opts.name ?? "Suunto Race 2 0042" });

  class ObjectManager extends Interface {
    GetManagedObjects() {
      const v = (s: string, x: unknown) => new Variant(s, x);
      const objects: Record<string, Record<string, Record<string, Variant>>> = {
        [ADAPTER]: { "org.bluez.Adapter1": { Address: v("s", "00:11:22:33:44:55"), Discovering: v("b", state.discovering) } },
        [DEVICE]: {
          "org.bluez.Device1": {
            Address: v("s", "C0:FF:EE:00:00:42"),
            Name: v("s", watch.name),
            Paired: v("b", state.paired),
            Trusted: v("b", state.trusted),
            Connected: v("b", state.connected),
            ServicesResolved: v("b", state.connected),
            UUIDs: v("as", []),
            ...(state.discovering ? { RSSI: v("n", -55) } : {}),
          },
          "org.bluez.Battery1": { Percentage: v("y", 87) },
        },
      };
      if (state.connected) {
        objects[SERVICE] = { "org.bluez.GattService1": { UUID: v("s", WB_SERVICE) } };
        objects[WRITE_CHAR] = { "org.bluez.GattCharacteristic1": { UUID: v("s", WB_WRITE), MTU: v("q", mtu) } };
        objects[NOTIFY_CHAR] = { "org.bluez.GattCharacteristic1": { UUID: v("s", WB_NOTIFY), MTU: v("q", mtu) } };
      }
      return objects;
    }
  }
  ObjectManager.configureMembers({ methods: { GetManagedObjects: { outSignature: "a{oa{sa{sv}}}" } } });

  let agentPath: string | null = null;
  class AgentManager extends Interface {
    RegisterAgent(path: string, _cap: string) {
      agentPath = path;
    }
    RequestDefaultAgent(_path: string) {}
    UnregisterAgent(_path: string) {
      agentPath = null;
    }
  }
  AgentManager.configureMembers({
    methods: { RegisterAgent: { inSignature: "os" }, RequestDefaultAgent: { inSignature: "o" }, UnregisterAgent: { inSignature: "o" } },
  });

  class Adapter extends Interface {
    SetDiscoveryFilter(_f: unknown) {}
    StartDiscovery() {
      state.discovering = true;
    }
    StopDiscovery() {
      state.discovering = false;
    }
    RemoveDevice(_p: string) {
      state.paired = state.trusted = false;
    }
  }
  Adapter.configureMembers({
    methods: { SetDiscoveryFilter: { inSignature: "a{sv}" }, StartDiscovery: {}, StopDiscovery: {}, RemoveDevice: { inSignature: "o" } },
  });

  class Device extends Interface {
    get ServicesResolved() {
      return state.connected;
    }
    get Connected() {
      return state.connected;
    }
    get Trusted() {
      return state.trusted;
    }
    set Trusted(v: boolean) {
      state.trusted = v;
    }
    async Pair() {
      if (!state.discovering) throw new dbus.DBusError("org.bluez.Error.DoesNotExist", "Device not available");
      if (!agentPath) throw new dbus.DBusError("org.bluez.Error.AuthenticationFailed", "no agent");
      const agent = await findAgent(bus, agentPath);
      const passkey = (await agent.RequestPasskey(DEVICE)) as number;
      state.passkeyEntered = passkey;
      if (opts.passkey && passkey !== Number(opts.passkey)) throw new dbus.DBusError("org.bluez.Error.AuthenticationFailed", "wrong passkey");
      state.paired = true;
    }
    Connect() {
      if (!state.paired) throw new dbus.DBusError("org.bluez.Error.Failed", "le-connection-abort-by-local");
      state.connected = true;
      watch = new FakeWatch({ ...opts, name: watch.name });
    }
    Disconnect() {
      state.connected = false;
      Interface.emitPropertiesChanged(device as AnyIface, { Connected: false }, []);
    }
  }
  Device.configureMembers({
    properties: {
      ServicesResolved: { signature: "b", access: "read" },
      Connected: { signature: "b", access: "read" },
      Trusted: { signature: "b", access: "readwrite" },
    },
    methods: { Pair: {}, Connect: {}, Disconnect: {} },
  });

  class WriteChar extends Interface {
    async WriteValue(value: Buffer, _o: unknown) {
      await watch.write(new Uint8Array(value));
    }
  }
  WriteChar.configureMembers({ methods: { WriteValue: { inSignature: "aya{sv}" } } });

  class NotifyChar extends Interface {
    Value = Buffer.alloc(0);
    async StartNotify() {
      await watch.subscribe((chunk) => {
        this.Value = Buffer.from(chunk);
        Interface.emitPropertiesChanged(this as AnyIface, { Value: this.Value }, []);
      });
    }
    StopNotify() {}
  }
  NotifyChar.configureMembers({
    properties: { Value: { signature: "ay", access: "read" } },
    methods: { StartNotify: {}, StopNotify: {} },
  });

  const device = new Device("org.bluez.Device1");
  bus.export("/", new ObjectManager("org.freedesktop.DBus.ObjectManager"));
  bus.export("/org/bluez", new AgentManager("org.bluez.AgentManager1"));
  bus.export(ADAPTER, new Adapter("org.bluez.Adapter1"));
  bus.export(DEVICE, device);
  bus.export(WRITE_CHAR, new WriteChar("org.bluez.GattCharacteristic1"));
  bus.export(NOTIFY_CHAR, new NotifyChar("org.bluez.GattCharacteristic1"));
  await bus.requestName("org.bluez", 0);

  return { state, stop: () => bus.disconnect() };
}

/** Find which connection exported the agent (dbus-next does not expose the caller's name). */
async function findAgent(bus: MessageBus, path: string) {
  const dbusObj = await bus.getProxyObject("org.freedesktop.DBus", "/org/freedesktop/DBus");
  const names = (await dbusObj.getInterface("org.freedesktop.DBus").ListNames!()) as string[];
  for (const name of names.filter((n) => n.startsWith(":") && n !== (bus as unknown as { name: string }).name)) {
    try {
      const obj = await bus.getProxyObject(name, path);
      const agent = obj.getInterface("org.bluez.Agent1");
      if (agent) return agent as unknown as { RequestPasskey(d: string): Promise<number> };
    } catch {
      // not this connection
    }
  }
  throw new Error("agent not found on the bus");
}
