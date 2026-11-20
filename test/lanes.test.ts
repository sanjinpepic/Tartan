import { expect, test } from "bun:test";
import { plainSyncError } from "../web/lib/lanes.ts";

test("Strava failures read as what happened and what to try", () => {
  const say = (m: string) => plainSyncError("strava", new Error(m)).text;
  expect(say("java.security.cert.CertPathValidatorException: Trust anchor for certification path not found.")).toBe("The phone couldn't trust the connection to Strava.");
  expect(say("javax.net.ssl.SSLHandshakeException: Chain validation failed")).toBe("The phone couldn't trust the connection to Strava.");
  expect(say("HTTP 429 Too Many Requests")).toBe("Strava asked Tartan to slow down.");
  expect(say("401 Unauthorized")).toBe("Strava wants you to sign in again.");
  expect(say("Failed to fetch")).toBe("Couldn't reach Strava.");
});
