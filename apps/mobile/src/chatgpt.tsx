import { ExternalLink, LogOut, Sparkles } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { Linking, Text, View } from "react-native";
import { Button, Card, ErrorNotice, s } from "./ui";
import { useWorkspace } from "./workspace";

interface ChatGPTStatus {
  connected: boolean;
  account?: { email?: string; plan?: string };
  pending?: { userCode: string; verificationUrl: string; expiresAt: string };
  error?: string;
}

/** Sign in with a ChatGPT subscription so chatgpt/ models run on it. */
export function ChatGPTConnection() {
  const { api, workspace } = useWorkspace();
  const [status, setStatus] = useState<ChatGPTStatus>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(
    () =>
      api
        .request<ChatGPTStatus>("/api/chatgpt")
        .then(setStatus)
        .catch((e) => setError(e instanceof Error ? e.message : String(e))),
    [api],
  );
  useEffect(() => {
    void load();
  }, [load]);
  // Poll while a sign-in code is waiting for approval.
  useEffect(() => {
    if (!status?.pending) return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [status?.pending, load]);
  async function run(path: string, method: string) {
    setBusy(true);
    setError("");
    try {
      setStatus(await api.request<ChatGPTStatus>(path, method === "POST" ? {} : undefined, method));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const model = workspace.runtime.model;
  const usesChatGPT = model?.startsWith("chatgpt/");
  return (
    <Card style={{ gap: 12 }}>
      <View style={[s.row, { gap: 10 }]}>
        <Sparkles size={19} />
        <Text style={s.heading}>ChatGPT subscription</Text>
      </View>
      {status?.connected ? (
        <Text style={s.text}>
          Signed in{status.account?.email ? ` as ${status.account.email}` : ""}
          {status.account?.plan ? ` · ${status.account.plan}` : ""}.
        </Text>
      ) : (
        <Text style={s.muted}>
          Use your ChatGPT plan instead of an API key. Set MODEL to chatgpt/&lt;model&gt; on the
          server.
        </Text>
      )}
      {!!model && (
        <Text style={s.small}>
          {usesChatGPT
            ? `Model ${model} runs on this sign-in.`
            : `Model ${model} uses its API key, not this sign-in.`}
        </Text>
      )}
      {status?.pending && (
        <View style={{ gap: 8 }}>
          <Text style={s.text}>Open the link, sign in to ChatGPT and enter this code:</Text>
          <Text selectable style={[s.heading, { fontSize: 26, letterSpacing: 3 }]}>
            {status.pending.userCode}
          </Text>
          <Button
            icon={ExternalLink}
            onPress={() => void Linking.openURL(status.pending?.verificationUrl ?? "")}
          >
            Open {status.pending.verificationUrl.replace("https://", "")}
          </Button>
          <Text style={s.small}>Waiting for approval… This page updates by itself.</Text>
          <Button small disabled={busy} onPress={() => void run("/api/chatgpt/login", "DELETE")}>
            Cancel
          </Button>
        </View>
      )}
      <ErrorNotice error={error || status?.error} />
      {!status?.pending &&
        (status?.connected ? (
          <Button
            danger
            icon={LogOut}
            busy={busy}
            onPress={() => void run("/api/chatgpt", "DELETE")}
          >
            Sign out of ChatGPT
          </Button>
        ) : (
          <Button primary busy={busy} onPress={() => void run("/api/chatgpt/login", "POST")}>
            Sign in with ChatGPT
          </Button>
        ))}
    </Card>
  );
}
