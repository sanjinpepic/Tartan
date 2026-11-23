/**
 * MCP server: gives LLM agents (Claude Desktop, Claude Code, Cursor, any MCP client)
 * read access to everything Tartan has collected, plus actions to refresh it.
 *
 *   stdio:  bun src/cli.ts mcp
 *   HTTP:   POST http://127.0.0.1:5173/mcp   (served by `bun src/cli.ts serve`)
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { NodeDisk } from "./disk-node.ts";
import { Library } from "./library.ts";
import { mondayOf, PLANNING_RULES, today } from "./plan.ts";
import { dataTools } from "./tools.ts";

export interface McpOptions {
  library?: Library;
  /** Allow the sync tools (network / Bluetooth). Default true. */
  allowSync?: boolean;
}

export const INSTRUCTIONS =
  "Tartan: the user's training data, merged from Strava (full detail and time series), files copied off their " +
  "watch over Bluetooth (Suunto today), and workouts an earlier version exported from the Suunto cloud. Each workout appears ONCE: copies in " +
  "several sources are merged, every field comes from one source (see provenance) and the time series from " +
  "one source, so nothing is double counted. Start with get_overview or get_takeaways, then list_activities " +
  "and drill into get_activity / get_activity_streams. The athlete's training plan (the same one the app's Coach tab " +
  "shows) is readable with get_training_plan and get_week and can be written with save_training_plan, " +
  "mark_plan_session, swap_plan_session (a run as a swim, a ride, on the treadmill, shorter or on another day, when the athlete picks it; get_habits has the choices and what suits them), set_training_availability and set_training_times (when they usually train); a workout nothing recorded is logged with log_workout (remove_logged_workout takes it back); see the training_plan prompt for how to plan. " +
  "Routes the athlete drew in the app are in list_routes / get_route (GPX for the watch), and save_route keeps a line as a route. " +
  "Units: km, minutes, min/km, bpm. Dates are ISO 8601 UTC.";

export function createMcpServer(opts: McpOptions = {}): McpServer {
  const lib = opts.library ?? new Library(new NodeDisk());
  const server = new McpServer({ name: "tartan", version: "0.3.0" }, { instructions: INSTRUCTIONS });

  const backupWatch = async (o: { root: string; needle?: string }) => {
    if (process.platform !== "linux") throw new Error("Bluetooth backup from the server needs Linux/BlueZ. On other systems use the app, then the files appear here.");
    const { backupWatch } = await import("./watch-backup.ts");
    return backupWatch(lib.local, o);
  };
  for (const t of dataTools(lib, { allowSync: opts.allowSync, backupWatch })) {
    server.registerTool(
      t.name,
      {
        description: t.description,
        inputSchema: t.schema.shape,
        annotations: t.readOnly
          ? { readOnlyHint: true, openWorldHint: false }
          : t.local
            ? { readOnlyHint: false, openWorldHint: false, destructiveHint: !!t.destructive }
            : { readOnlyHint: false, openWorldHint: true, idempotentHint: true },
      },
      (async (args: Record<string, unknown>) => {
        void lib.local.logEvent({ lane: "agent", kind: t.name });
        try {
          return { content: [{ type: "text" as const, text: JSON.stringify(await t.run(args ?? {})) }] };
        } catch (e) {
          return { content: [{ type: "text" as const, text: (e as Error).message }], isError: true };
        }
      }) as never,
    );
  }

  server.registerPrompt(
    "training_review",
    {
      description: "Review recent training: load, consistency, intensity and what to do next.",
      argsSchema: { weeks: z.string().optional().describe("how many weeks back, default 8") },
    },
    ({ weeks }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Review my last ${weeks ?? "8"} weeks of training. Start with get_takeaways and get_training_load, then ` +
              "get_training_summary (period week), list_activities for the same range, and get_activity / get_activity_streams " +
              "for the key sessions. Comment on volume trend, long sessions, intensity distribution from heart rate, and recovery, then suggest next week.",
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "training_plan",
    {
      description: "Make or change the athlete's training plan the way the in-app coach does, and save it to the app.",
      argsSchema: {
        target: z.string().optional().describe("a date to build to, in any words ('end of March'); default 8 weeks"),
        request: z.string().optional().describe("what to change or anything to take into account"),
      },
    },
    ({ target, request }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Today is ${today()}. ${target ? `Plan up to "${target}": work out the date, set target_date, and plan from this Monday (${mondayOf(today())}) through the week that contains it (26 weeks at most).` : `Plan 8 weeks from this Monday (${mondayOf(today())}), unless I ask otherwise below.`}\n` +
              `${request ? `My request: ${request}\n` : ""}\nHow to plan:\n${PLANNING_RULES}`,
          },
        },
      ],
    }),
  );

  return server;
}
