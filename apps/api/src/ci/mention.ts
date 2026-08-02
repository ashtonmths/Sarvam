import { log } from "../log.js";
import { answerInThread, failureForThread, questionFrom } from "./converse.js";
import { postThreadReply } from "./notify.js";

/**
 * A mention in a thread, turned into a reply.
 *
 * Kept apart from the webhook route so the route stays what it should be —
 * verify, ack, hand off — and this can be read as the behaviour rather than as
 * plumbing.
 */
export async function handleSlackMention(input: {
  channel: string;
  threadTs: string;
  text: string;
  user?: string;
}): Promise<void> {
  const failureId = await failureForThread(input.channel, input.threadTs);
  log().info(
    {
      event: "slack_mention",
      channel: input.channel,
      threadTs: input.threadTs,
      failureId,
    },
    failureId === null
      ? "slack: mentioned in a thread with no failure recorded against it"
      : "slack: mentioned in a diagnosis thread",
  );
  // A mention in some other thread is not ours to answer. Silence is right:
  // a bot that replies "I don't know what you mean" to every passing mention
  // is worse than one that stays out of conversations it has no part in.
  if (failureId === null) return;

  const question = questionFrom(input.text);
  if (question.length < 2) return;

  const answer = await answerInThread(failureId, question);
  if (!answer) return;

  await postThreadReply(failureId, input.user ? `<@${input.user}> ${answer}` : answer);
}
