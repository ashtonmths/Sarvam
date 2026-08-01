import { createServer, type Server } from "node:http";
import type { SlackMessage } from "./corpus.js";

/**
 * A Slack workspace that contains exactly what one eval case planted.
 *
 * The Historian reaches Slack over HTTP, so this is the honest seam: the agent
 * runs its real loop, calls its real tools, and parses real HTTP responses.
 * Stubbing `searchSlack` instead would test a different program from the one
 * that ships — the parsing, the pagination, the permalink round-trip and the
 * bot-token scan path would all go unexercised, and those are where the bugs
 * that matter to an eval actually live.
 *
 * Only the bot-token path (`conversations.history` + `chat.getPermalink`) is
 * served, because that is the fallback every org without a user token takes,
 * and `search.messages` returns `not_allowed_token_type` so the tool falls
 * through to it exactly as it would in production.
 */

export interface FixtureServer {
  url: string;
  /** Requests seen, so a case can assert the agent actually looked. */
  calls: string[];
  /** Swaps in the next case's workspace. */
  setPlanted: (planted: SlackMessage[]) => void;
  close: () => Promise<void>;
}

/**
 * A fixed port, and one server for the whole run rather than one per case.
 *
 * The Slack tools resolve their base URL from `config` at module scope, and ES
 * imports are evaluated before any statement in the runner — the same hoisting
 * that defeats OpenTelemetry's auto-instrumentation here. So the address has to
 * be known before the process starts, which means a constant the npm script
 * also names, and case isolation comes from swapping the contents instead.
 */
export const FIXTURE_PORT = 39517;

export async function startFixtureServer(
  initial: SlackMessage[] = [],
): Promise<FixtureServer> {
  const calls: string[] = [];
  let byChannel = new Map<string, SlackMessage[]>();

  const load = (planted: SlackMessage[]) => {
    byChannel = new Map<string, SlackMessage[]>();
    for (const message of planted) {
      byChannel.set(message.channel, [
        ...(byChannel.get(message.channel) ?? []),
        message,
      ]);
    }
  };
  load(initial);

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    calls.push(url.pathname);

    const json = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    switch (url.pathname) {
      case "/search.messages":
        // Mirrors what a bot token actually gets back from Slack, so the tool
        // takes its real fallback rather than a path invented for the test.
        return json({ ok: false, error: "not_allowed_token_type" });

      case "/conversations.history": {
        const channel = url.searchParams.get("channel") ?? "";
        const messages = (byChannel.get(channel) ?? []).map((m) => ({
          text: m.text,
          user: m.user,
          ts: m.ts,
        }));
        return json({ ok: true, messages });
      }

      case "/chat.getPermalink": {
        const channel = url.searchParams.get("channel") ?? "";
        const ts = url.searchParams.get("message_ts") ?? "";
        return json({
          ok: true,
          permalink: `https://sadhak-eval.slack.com/archives/${channel}/p${ts.replace(".", "")}`,
        });
      }

      case "/conversations.replies": {
        const channel = url.searchParams.get("channel") ?? "";
        const ts = url.searchParams.get("ts") ?? "";
        const parent = (byChannel.get(channel) ?? []).find((m) => m.ts === ts);
        if (!parent) return json({ ok: false, error: "thread_not_found" });
        return json({
          ok: true,
          messages: [
            { text: parent.text, user: parent.user, ts: parent.ts },
            ...(parent.replies ?? []).map((r) => ({
              text: r.text,
              user: r.user,
              ts: r.ts,
            })),
          ],
        });
      }

      // Anything else is a tool reaching for an endpoint this fixture does not
      // model. Answered as a Slack error rather than a 404 so the agent sees a
      // shape it knows, and recorded in `calls` so the gap is visible.
      default:
        return json({ ok: false, error: "unknown_method" });
    }
  });

  await new Promise<void>((resolve) => server.listen(FIXTURE_PORT, "127.0.0.1", resolve));

  return {
    url: `http://127.0.0.1:${FIXTURE_PORT}`,
    calls,
    setPlanted: (planted: SlackMessage[]) => {
      load(planted);
      calls.length = 0;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
