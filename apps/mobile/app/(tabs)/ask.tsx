import { Feather } from "@expo/vector-icons";
import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { ApiError, type AskAnswer, api } from "../../lib/api";
import { ScreenHead } from "../../lib/brand";
import { T } from "../../lib/theme";
import { body, display, mono } from "../../lib/type";
import { Button, Card, Empty, ErrorNote, Label, Screen } from "../../lib/ui";

/**
 * Decision helper.
 *
 * The same `POST /api/ask` the web panel and the `ask_docs` MCP tool use, so a
 * person on a phone, a person at a desk and an agent all get one answer to one
 * question. Nothing about the retrieval or the grounding lives here.
 *
 * The citations are the feature, not decoration. Everything else in Sadhak is
 * deterministic and checkable; a model's prose is the one place that stops
 * being true, so the sources sit under every answer and each one opens. An
 * answer you cannot check is a chatbot, and this is not meant to be one.
 */

/** Starters, so an empty box is not the first thing asked of the user. */
const PROMPTS = [
  "What did we decide about the billing schema?",
  "Why was the checkout workflow changed?",
  "What is still unresolved from last week?",
];

export default function Ask() {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<AskAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ask = useCallback(
    async (text: string) => {
      const q = text.trim();
      // The API floors at 3 characters; refusing here keeps a pointless
      // round trip and a 400 out of the user's way.
      if (q.length < 3 || busy) return;

      setBusy(true);
      setError(null);
      setAnswer(null);
      try {
        setAnswer(await api.post<AskAnswer>("/api/ask", { question: q }));
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Could not reach the API");
      } finally {
        setBusy(false);
      }
    },
    [busy],
  );

  return (
    <Screen>
      <ScreenHead
        title="Decide"
        subtitle="Ask in prose. Answers come from this org's documents, with the passages they rest on."
      />

      <Card>
        <TextInput
          style={s.input}
          value={question}
          onChangeText={setQuestion}
          placeholder="What should I know before changing this?"
          placeholderTextColor={T.inkFaint}
          multiline
          returnKeyType="send"
          onSubmitEditing={() => void ask(question)}
          editable={!busy}
        />
        <Button
          label="Ask"
          onPress={() => void ask(question)}
          disabled={busy || question.trim().length < 3}
          busy={busy ? <ActivityIndicator size="small" color={T.paper} /> : undefined}
        />
      </Card>

      {error ? <ErrorNote message={error} /> : null}

      {!answer && !busy && !error ? (
        <Card title="Try">
          {PROMPTS.map((prompt, i) => (
            <Pressable
              key={prompt}
              onPress={() => {
                setQuestion(prompt);
                void ask(prompt);
              }}
              accessibilityRole="button"
              style={({ pressed }) => [
                s.prompt,
                i === 0 && s.promptFirst,
                pressed && s.promptPressed,
              ]}
            >
              <Feather name="corner-down-right" size={14} color={T.inkFaint} />
              <Text style={s.promptText}>{prompt}</Text>
            </Pressable>
          ))}
        </Card>
      ) : null}

      {answer ? (
        <>
          {/* Retrieval worked and the model did not: the passages are still
              worth handing over, so this is a note above them rather than an
              error in place of them. */}
          {answer.unavailable ? <ErrorNote message={answer.unavailable} /> : null}

          {answer.answer ? (
            <Card title="Answer">
              <Text style={s.answer}>{answer.answer}</Text>
            </Card>
          ) : null}

          <Card title={`Sources (${answer.sources.length})`}>
            {answer.sources.length === 0 ? (
              <Empty
                icon="file-text"
                text="Nothing in this org's documents covers that yet."
              />
            ) : (
              answer.sources.map((source, i) => (
                <Pressable
                  key={source.n}
                  onPress={() => void Linking.openURL(source.permalink).catch(() => {})}
                  accessibilityRole="link"
                  style={({ pressed }) => [
                    s.source,
                    i === 0 && s.sourceFirst,
                    pressed && s.sourcePressed,
                  ]}
                >
                  <View style={s.sourceHead}>
                    <Text style={s.sourceN}>[{source.n}]</Text>
                    <Text style={s.sourceTitle} numberOfLines={1}>
                      {source.title}
                    </Text>
                    <Feather name="external-link" size={13} color={T.inkFaint} />
                  </View>
                  {source.speaker || source.occurredAt ? (
                    <Label>
                      {[source.speaker, source.occurredAt?.slice(0, 10)]
                        .filter(Boolean)
                        .join(" · ")}
                    </Label>
                  ) : null}
                  <Text style={s.sourceExcerpt} numberOfLines={4}>
                    {source.excerpt}
                  </Text>
                </Pressable>
              ))
            )}
          </Card>
        </>
      ) : null}
    </Screen>
  );
}

const s = StyleSheet.create({
  input: {
    fontFamily: body("400"),
    fontSize: 15,
    lineHeight: 22,
    color: T.ink,
    minHeight: 78,
    textAlignVertical: "top",
    marginBottom: 14,
  },

  prompt: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: T.lineSoft,
  },
  promptFirst: { borderTopWidth: 0 },
  promptPressed: { opacity: 0.5 },
  promptText: { fontFamily: body("500"), fontSize: 13.5, color: T.inkSoft, flex: 1 },

  answer: { fontFamily: body("400"), fontSize: 15, lineHeight: 23, color: T.ink },

  source: {
    paddingVertical: 13,
    borderTopWidth: 1,
    borderTopColor: T.lineSoft,
    gap: 5,
  },
  sourceFirst: { borderTopWidth: 0 },
  sourcePressed: { opacity: 0.55 },
  sourceHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  sourceN: { fontFamily: mono("600"), fontSize: 12, color: T.thread },
  sourceTitle: { fontFamily: display("600"), fontSize: 14, color: T.ink, flex: 1 },
  sourceExcerpt: {
    fontFamily: body("400"),
    fontSize: 12.5,
    lineHeight: 18,
    color: T.inkFaint,
  },
});
