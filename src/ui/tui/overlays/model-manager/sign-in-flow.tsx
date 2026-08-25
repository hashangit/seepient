/**
 * Seepient TUI — OAuth Sign In Flow Overlay
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { useTheme } from "../../hooks/use-theme.js";
import type { ProviderManagerApi } from "../../../../transport/cli/provider-manager-api.js";

export interface SignInFlowProps {
  upstream: string;
  api: ProviderManagerApi;
  onDone: (msg: string) => void;
  onCancel: () => void;
}

export function SignInFlow({ upstream, api, onDone, onCancel }: SignInFlowProps) {
  const theme = useTheme();
  const [status, setStatus] = useState<"initiating" | "device_code" | "waiting" | "error">("initiating");
  const [deviceInfo, setDeviceInfo] = useState<{ userCode: string; verificationUrl: string; expiresInMs: number } | null>(null);
  const [browserUrl, setBrowserUrl] = useState<string | null>(null);
  const [browserInstructions, setBrowserInstructions] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const startedRef = useRef(false);
  const abortControllerRef = useRef(new AbortController());
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  const start = useCallback(async () => {
    setStatus("initiating");
    setError(null);
    try {
      const res = await api.signInWithProvider(upstream, {
        signal: abortControllerRef.current.signal,
        onDeviceCode: (info) => {
          setDeviceInfo(info);
          setStatus("device_code");
        },
        onBrowserOpen: (url, instructions) => {
          setBrowserUrl(url);
          setBrowserInstructions(instructions ?? null);
          setStatus("waiting");
        },
        onWaiting: () => {
          setStatus("waiting");
        },
      });

      if (res.ok) {
        onDoneRef.current(`✓ Signed in with ${upstream}`);
      } else {
        if (abortControllerRef.current.signal.aborted) {
          onCancelRef.current();
          return;
        }
        setError(res.error.message);
        setStatus("error");
      }
    } catch (err: any) {
      if (abortControllerRef.current.signal.aborted) {
        onCancelRef.current();
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setStatus("error");
    }
  }, [upstream, api]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void start();
    return () => {
      abortControllerRef.current.abort();
    };
  }, [start]);

  useInput((input, key) => {
    if (key.escape) {
      abortControllerRef.current.abort();
      onCancel();
      return;
    }
    if (status === "error") {
      if (input === "1") {
        abortControllerRef.current = new AbortController();
        void start();
      } else if (input === "2") {
        abortControllerRef.current.abort();
        onCancel();
      }
    }
  });

  if (status === "error") {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.red} paddingLeft={1} paddingRight={1}>
        <Text color={theme.red} bold>Sign in with {upstream} failed</Text>
        <Text color={theme.fg}>{error}</Text>
        <Box marginTop={1}>
          <Text color={theme.fgDim}> [1] Try again   [2] Cancel (Esc) </Text>
        </Box>
      </Box>
    );
  }

  if (status === "device_code" && deviceInfo) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.cyan} paddingLeft={1} paddingRight={1}>
        <Text color={theme.cyan} bold>Sign in with {upstream}</Text>
        <Text>1. Open this URL in your browser: <Text color={theme.blue} underline>{deviceInfo.verificationUrl}</Text></Text>
        <Text>2. Enter confirmation code: <Text color={theme.yellow} bold>{deviceInfo.userCode}</Text></Text>
        <Text color={theme.fgDim}>Waiting for authorization in browser… (Esc to cancel)</Text>
      </Box>
    );
  }

  if (status === "waiting" && browserUrl) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.cyan} paddingLeft={1} paddingRight={1}>
        <Text color={theme.cyan} bold>Sign in with {upstream}</Text>
        <Text>Complete authentication in your browser:</Text>
        <Text color={theme.blue} underline>{browserUrl}</Text>
        <Text color={theme.fgDim}>If you're not already signed in, the page will ask you to sign in or create an account first — then approve access.</Text>
        {browserInstructions ? <Text color={theme.fgDim}>{browserInstructions}</Text> : null}
        <Text color={theme.fgDim}>Waiting for browser callback… (Esc to cancel)</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.cyan} paddingLeft={1} paddingRight={1}>
      <Text color={theme.cyan} bold>Connecting to {upstream}…</Text>
      <Text color={theme.fgDim}>Initiating sign-in flow… (Esc to cancel)</Text>
    </Box>
  );
}
