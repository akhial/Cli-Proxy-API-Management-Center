import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNow } from '@/hooks/useNow';
import { useAuthStore } from '@/stores/useAuthStore';
import { useNotificationStore } from '@/stores';
import { apiClient } from '@/services/api/client';
import {
  AnthropicResetGrantError,
  type AnthropicResetGrantStatus,
} from '@/services/api/claudeResetGrants';
import type { AuthFileItem } from '@/types';
import { normalizeAuthIndex } from '@/utils/quota';
import {
  resetGrantOperations,
  RETRY_WINDOW_MS,
  ResetGrantPreflightError,
  resetGrantFailureMessageKey,
} from './resetGrantOperations';
import { resetGrantKind, resetGrantLines, type ResetGrantKind } from './resetGrantKinds';
import { selectResetGrant } from './selectResetGrant';
import { readResetGrantsForCard, scheduleResetGrantRead } from './resetGrantReads';

/** One kind of banked reset on an account, with the action that spends it. */
export type ClaudeResetLine = {
  /** Null only for an unresolved claim whose grant is no longer listed. */
  kind: ResetGrantKind | null;
  count: number | null;
  expiresAtMs: number | null;
  /** The action retries an unresolved claim instead of starting a new one. */
  retry: boolean;
  /** This line's claim is in flight. */
  busy: boolean;
  blocked: boolean;
  confirm: () => void;
};

/** Card-owned reads; the session-scoped journal owns spending and ambiguous retries. */
export function useClaudeResetGrants(
  file: AuthFileItem,
  enabled: boolean,
  disabled: boolean,
  refreshToken: unknown,
  onRefresh: () => void,
  /** Saved grants from quota history, shown until a live read replaces them. */
  saved: AnthropicResetGrantStatus | null = null
) {
  const { t } = useTranslation();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const [session] = useState(() => apiClient.getConnectionRevision());
  const sessionActive =
    connectionStatus === 'connected' && session === apiClient.getConnectionRevision();
  const showConfirmation = useNotificationStore((state) => state.showConfirmation);
  const showNotification = useNotificationStore((state) => state.showNotification);
  const now = useNow();
  const authIndex = normalizeAuthIndex(file.auth_index ?? file.authIndex);
  const key = JSON.stringify([file.name, authIndex]);
  const [liveStatus, setStatus] = useState<AnthropicResetGrantStatus | null>(null);
  const status = liveStatus ?? saved;
  // The grant being claimed; one claim runs at a time.
  const [busyGrant, setBusyGrant] = useState<string | null>(null);
  const busy = busyGrant !== null;
  const [message, setMessage] = useState('');
  const [reload, setReload] = useState(0);
  const lock = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    const version = ++generation.current;
    setStatus(null);
    if (!enabled || disabled || !sessionActive || !authIndex) return;
    let cancelled = false;
    const current = () =>
      !cancelled && version === generation.current && session === apiClient.getConnectionRevision();
    const cancelRead = scheduleResetGrantRead(() => {
      void readResetGrantsForCard(authIndex).then(
        (result) => {
          if (current()) {
            setStatus(result);
            setMessage('');
          }
        },
        (error: unknown) => {
          if (current()) {
            setMessage(
              error instanceof AnthropicResetGrantError && error.code === 'rate_limited'
                ? 'rate_limited'
                : 'read_error'
            );
          }
        }
      );
    }, current);
    return () => {
      cancelled = true;
      cancelRead();
      generation.current += 1;
    };
  }, [authIndex, key, enabled, disabled, sessionActive, session, refreshToken, reload]);

  const operation = resetGrantOperations.inspect(key);
  const pending = operation && !operation.code ? operation : undefined;
  const expired = Boolean(pending && now - pending.createdAt >= RETRY_WINDOW_MS);
  const unavailable = disabled || !sessionActive || !authIndex || busy || expired;
  const kindOf = (grantId: string | undefined): ResetGrantKind | null => {
    const grant = status?.grants.find((candidate) => candidate.id === grantId);
    return grant ? resetGrantKind(grant) : null;
  };
  const pendingKind = kindOf(pending?.grantId);
  /** The grant a button spends. While a claim is unresolved, only that claim can be retried. */
  const grantFor = (kind?: ResetGrantKind) => {
    if (pending) return kind === undefined || kind === pendingKind ? pending.grantId : undefined;
    return status ? selectResetGrant(status, now, kind)?.id : undefined;
  };
  const confirmGrant = (selected: string | undefined) => {
    if (unavailable || lock.current || !selected || !authIndex) return;
    const version = generation.current;
    const current = () =>
      session === apiClient.getConnectionRevision() && version === generation.current;
    const confirmText =
      kindOf(selected) === 'fable'
        ? 'claude_reset.confirm_text_fable'
        : 'claude_reset.confirm_text';
    showConfirmation({
      title: t('claude_reset.title'),
      message: t(pending ? 'claude_reset.retry_confirm' : confirmText, {
        name: file.name,
      }),
      confirmText: t(pending ? 'claude_reset.retry' : 'claude_reset.confirm'),
      variant: 'primary',
      onConfirm: async () => {
        if (!current() || lock.current || useAuthStore.getState().connectionStatus !== 'connected')
          return;
        lock.current = true;
        setBusyGrant(selected);
        try {
          const answer = await resetGrantOperations.run(key, authIndex, selected);
          if (!current()) return;
          showNotification(
            answer.code === 'cooldown_clear_failed'
              ? t('auth_files.cooldown_reset_failed', {
                  name: file.name,
                  message: t('common.unknown_error'),
                })
              : t(`claude_reset.${answer.unresolved ? 'unknown' : answer.code}`),
            !answer.unresolved && (answer.code === 'reset' || answer.code === 'already_used')
              ? 'success'
              : 'error'
          );
        } catch (error: unknown) {
          if (!current()) return;
          const unresolved = resetGrantOperations.inspect(key);
          showNotification(
            t(
              unresolved && !unresolved.code
                ? 'claude_reset.unknown'
                : resetGrantFailureMessageKey(error),
              {
                code: error instanceof ResetGrantPreflightError ? error.reason : '',
              }
            ),
            'error'
          );
        } finally {
          lock.current = false;
          // A concurrent page-wide refresh can invalidate this read generation.
          // Release the local lock regardless, but never refresh a replacement account.
          setBusyGrant(null);
          setReload((value) => value + 1);
          if (current()) onRefresh();
        }
      },
    });
  };
  const selected = grantFor();
  const grantLines = resetGrantLines(status?.grants ?? [], now).map((line) => {
    const grantId = grantFor(line.kind);
    return {
      ...line,
      grantId,
      retry: Boolean(pending) && line.kind === pendingKind,
      busy: busy && grantId === busyGrant,
      blocked: unavailable || !grantId,
    };
  });
  // An unresolved claim keeps its retry even when its grant no longer shows resets.
  const shownLines =
    pending && !grantLines.some((line) => line.retry)
      ? [
          ...grantLines,
          {
            kind: pendingKind,
            count: null,
            expiresAtMs: null,
            grantId: pending.grantId,
            retry: true,
            busy: busyGrant === pending.grantId,
            blocked: unavailable,
          },
        ]
      : grantLines;
  const lines: ClaudeResetLine[] = shownLines.map(({ grantId, ...line }) => ({
    ...line,
    confirm: () => confirmGrant(grantId),
  }));
  return {
    count: status?.grants.reduce((sum, grant) => sum + grant.resetsLeft, 0) ?? null,
    grants: status?.grants ?? [],
    /** Whether the grants have been read; `lines` is empty until then. */
    known: status !== null,
    lines,
    busy,
    blocked: unavailable || !selected,
    confirm: () => confirmGrant(selected),
    message: pending ? (expired ? 'expired' : 'unknown') : message,
    buttonLabel: pending ? 'retry' : 'use',
  };
}
