import { isNative } from "../state.ts";

/** Hand a file to the user: the share sheet on the phone (save to Files, Drive, or send), a download elsewhere. */
export async function saveFile(name: string, text: string, type: string, dialogTitle = "Save or send it"): Promise<void> {
  if (isNative) {
    const { Directory, Encoding, Filesystem } = await import("@capacitor/filesystem");
    const { Share } = await import("@capacitor/share");
    const { uri } = await Filesystem.writeFile({ path: name, data: text, directory: Directory.Cache, encoding: Encoding.UTF8 });
    await Share.share({ title: name, files: [uri], dialogTitle });
    return;
  }
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}


/** The same for binary files (a watch-face package). */
export async function saveBytes(name: string, data: Uint8Array, type: string, dialogTitle = "Save or send it"): Promise<void> {
  if (isNative) {
    const { Directory, Filesystem } = await import("@capacitor/filesystem");
    const { Share } = await import("@capacitor/share");
    let bin = "";
    for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode(...data.subarray(i, i + 0x8000));
    const { uri } = await Filesystem.writeFile({ path: name, data: btoa(bin), directory: Directory.Cache });
    await Share.share({ title: name, files: [uri], dialogTitle });
    return;
  }
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([new Uint8Array(data)], { type })), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
