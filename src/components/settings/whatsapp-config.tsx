'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { toast } from 'sonner';
import {
  Eye,
  EyeOff,
  Copy,
  CheckCircle2,
  XCircle,
  Loader2,
  ExternalLink,
  Zap,
  AlertTriangle,
  RotateCcw,
  QrCode,
  Smartphone,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { SettingsPanelHead } from './settings-panel-head';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@/components/ui/accordion';
import type { WhatsAppConfig as WhatsAppConfigType, WhatsAppProvider } from '@/types';

const MASKED_TOKEN = '••••••••••••••••';

type ConnectionStatus = 'connected' | 'disconnected' | 'unknown';
type ResetReason = 'token_corrupted' | 'meta_api_error' | null;

export function WhatsAppConfig() {
  const t = useTranslations('Settings.whatsapp');
  const supabase = createClient();
  // After multi-user, whatsapp_config is one-row-per-account, not
  // one-row-per-user. We pull `accountId` straight off the auth
  // context and key every read off it — so a teammate who just
  // joined an account sees the inviter's saved config without
  // having to re-enter anything.
  const { user, accountId, loading: authLoading, profileLoading } = useAuth();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [config, setConfig] = useState<WhatsAppConfigType | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('unknown');
  const [resetReason, setResetReason] = useState<ResetReason>(null);
  const [statusMessage, setStatusMessage] = useState<string>('');
  // Guards against re-hydrating the form when the load effect below
  // re-runs for reasons unrelated to actually switching accounts —
  // e.g. Supabase's onAuthStateChange fires a token refresh (new
  // `user` object, profileLoading flips true/false) when the browser
  // tab regains focus. Without this, that churn calls fetchConfig()
  // again and overwrites whatever the user typed but hadn't saved yet.
  const loadedAccountIdRef = useRef<string | null>(null);

  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [wabaId, setWabaId] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [verifyToken, setVerifyToken] = useState('');
  const [pin, setPin] = useState('');
  const [tokenEdited, setTokenEdited] = useState(false);

  // Provider picker. Defaults to 'meta' until fetchConfig loads the
  // saved row — whatsapp_config is one row per account (UNIQUE on
  // account_id), so this reflects whichever provider is currently
  // connected, not a per-form preference.
  const [provider, setProvider] = useState<WhatsAppProvider>('meta');
  const [baseUrl, setBaseUrl] = useState('');
  const [instanceToken, setInstanceToken] = useState('');
  const [instanceTokenEdited, setInstanceTokenEdited] = useState(false);
  const [instanceName, setInstanceName] = useState('');
  const [savingUazapi, setSavingUazapi] = useState(false);
  const [connectingUazapi, setConnectingUazapi] = useState(false);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [uazapiConnected, setUazapiConnected] = useState(false);
  const [uazapiPhone, setUazapiPhone] = useState<string | null>(null);
  // Polls /api/whatsapp/config/uazapi after Connect is clicked, until
  // status flips to connected — the QR pairing itself happens on the
  // phone, so this is the only way the UI learns it succeeded.
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Evolution API fields — same shape as the uazapi block above (an
  // instance URL + a per-instance credential + an instance name), kept
  // as its own set of hooks rather than generalized, matching how the
  // uazapi block was kept separate from Meta's.
  const [evolutionBaseUrl, setEvolutionBaseUrl] = useState('');
  const [evolutionApiKey, setEvolutionApiKey] = useState('');
  const [evolutionApiKeyEdited, setEvolutionApiKeyEdited] = useState(false);
  const [evolutionInstanceName, setEvolutionInstanceName] = useState('');
  const [savingEvolution, setSavingEvolution] = useState(false);
  const [connectingEvolution, setConnectingEvolution] = useState(false);
  const [evolutionConnected, setEvolutionConnected] = useState(false);
  const [evolutionPhone, setEvolutionPhone] = useState<string | null>(null);
  const evolutionPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // True once /register has succeeded on Meta's side (timestamp set
  // in the row). When false, the saved config is metadata-only and
  // Meta will silently drop every inbound event — that's the
  // multi-number bug that prompted this work.
  const isRegistered = Boolean(config?.registered_at);
  const lastRegistrationError = config?.last_registration_error ?? null;

  const [verifyingRegistration, setVerifyingRegistration] = useState(false);
  type RegistrationProbe = {
    live: boolean;
    checks: Record<string, boolean | null>;
    errors?: string[];
    last_registration_error?: string | null;
    registered_at?: string | null;
    subscribed_apps_at?: string | null;
  };
  const [registrationProbe, setRegistrationProbe] =
    useState<RegistrationProbe | null>(null);

  const webhookUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/api/whatsapp/webhook`
      : '';

  const fetchConfig = useCallback(async (acctId: string) => {
    setLoading(true);
    try {
      // Load form values from Supabase (shows what's in DB).
      // Switched from `user_id` (which would only match the row's
      // original author) to `account_id` so every member of the
      // account sees the same saved configuration. UNIQUE(account_id)
      // on the table guarantees the .maybeSingle() return type
      // remains accurate.
      const { data, error } = await supabase
        .from('whatsapp_config')
        .select('*')
        .eq('account_id', acctId)
        .maybeSingle();

      if (error) {
        console.error('Failed to load config row:', error);
      }

      const rowProvider: WhatsAppProvider = data?.provider ?? 'meta';
      setProvider(rowProvider);

      if (data) {
        setConfig(data);
        setPhoneNumberId(data.phone_number_id || '');
        setWabaId(data.waba_id || '');
        setAccessToken(MASKED_TOKEN);
        setVerifyToken('');
        setPin('');
        setTokenEdited(false);

        setBaseUrl(data.base_url || '');
        setInstanceToken(data.instance_token ? MASKED_TOKEN : '');
        setInstanceTokenEdited(false);
        setInstanceName(data.instance_name || '');
        setUazapiPhone(data.paired_phone || null);

        setEvolutionBaseUrl(data.evolution_base_url || '');
        setEvolutionApiKey(data.evolution_api_key ? MASKED_TOKEN : '');
        setEvolutionApiKeyEdited(false);
        setEvolutionInstanceName(data.evolution_instance_name || '');
        setEvolutionPhone(data.evolution_paired_phone || null);
      } else {
        setConfig(null);
        setPhoneNumberId('');
        setWabaId('');
        setAccessToken('');
        setVerifyToken('');
        setPin('');
        setTokenEdited(false);

        setBaseUrl('');
        setInstanceToken('');
        setInstanceTokenEdited(false);
        setInstanceName('');
        setUazapiPhone(null);

        setEvolutionBaseUrl('');
        setEvolutionApiKey('');
        setEvolutionApiKeyEdited(false);
        setEvolutionInstanceName('');
        setEvolutionPhone(null);
      }
      // Clear any stale probe result when reloading the row.
      setRegistrationProbe(null);
      setQrCode(null);
      setPairingCode(null);

      // Then verify health via the provider-specific API (decrypts
      // token + pings Meta, uazapi, or Evolution).
      if (data && rowProvider === 'uazapi') {
        try {
          const res = await fetch('/api/whatsapp/config/uazapi', { method: 'GET' });
          const payload = await res.json();
          setUazapiConnected(Boolean(payload.connected));
          if (payload.phone) setUazapiPhone(payload.phone);
          setConnectionStatus(payload.connected ? 'connected' : 'disconnected');
          setResetReason(payload.needs_reset ? 'token_corrupted' : null);
          setStatusMessage(payload.message || '');
        } catch (err) {
          console.error('uazapi health check failed:', err);
          setUazapiConnected(false);
          setConnectionStatus('disconnected');
        }
      } else if (data && rowProvider === 'evolution') {
        try {
          const res = await fetch('/api/whatsapp/config/evolution', { method: 'GET' });
          const payload = await res.json();
          setEvolutionConnected(Boolean(payload.connected));
          if (payload.phone) setEvolutionPhone(payload.phone);
          setConnectionStatus(payload.connected ? 'connected' : 'disconnected');
          setResetReason(payload.needs_reset ? 'token_corrupted' : null);
          setStatusMessage(payload.message || '');
        } catch (err) {
          console.error('Evolution health check failed:', err);
          setEvolutionConnected(false);
          setConnectionStatus('disconnected');
        }
      } else if (data) {
        try {
          const res = await fetch('/api/whatsapp/config', { method: 'GET' });
          const payload = await res.json();

          if (payload.connected) {
            setConnectionStatus('connected');
            setResetReason(null);
            setStatusMessage('');
          } else {
            setConnectionStatus('disconnected');
            setResetReason(payload.needs_reset ? 'token_corrupted' : payload.reason === 'meta_api_error' ? 'meta_api_error' : null);
            setStatusMessage(payload.message || '');
          }
        } catch (err) {
          console.error('Health check failed:', err);
          setConnectionStatus('disconnected');
        }
      } else {
        setConnectionStatus('disconnected');
        setResetReason(null);
        setStatusMessage('');
        setUazapiConnected(false);
        setEvolutionConnected(false);
      }
    } catch (err) {
      console.error('fetchConfig error:', err);
      toast.error('Failed to load WhatsApp configuration');
    } finally {
      setLoading(false);
    }
  }, [supabase]);

  useEffect(() => {
    // Need both the auth session (`!authLoading`) AND the profile
    // (`!profileLoading`, which carries `accountId`). Without the
    // second guard, the effect would fire with `accountId === null`
    // for the first render window and bail without ever retrying
    // once the profile arrives.
    if (authLoading || profileLoading) return;
    if (!user || !accountId) {
      loadedAccountIdRef.current = null;
      setLoading(false);
      return;
    }
    if (loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    fetchConfig(accountId);
  }, [authLoading, profileLoading, user?.id, accountId, fetchConfig]);

  async function handleSave() {
    if (!phoneNumberId.trim()) {
      toast.error('Phone Number ID is required');
      return;
    }
    if (!config && (!accessToken.trim() || !tokenEdited)) {
      toast.error('Access Token is required for initial setup');
      return;
    }

    try {
      setSaving(true);

      // Always POST through the API — it verifies with Meta and encrypts
      // the access_token server-side with ENCRYPTION_KEY. Skipping this
      // and writing direct to Supabase stores the token in plaintext,
      // which then fails decryption on every subsequent health check.
      const payload: Record<string, unknown> = {
        phone_number_id: phoneNumberId.trim(),
        waba_id: wabaId.trim() || null,
        verify_token: verifyToken.trim() || null,
        // Optional — only sent when the user filled it in. The server
        // requires it on first save or when changing numbers; for a
        // simple token rotation, leaving it blank skips re-register.
        pin: pin.trim() || null,
      };

      if (tokenEdited && accessToken !== MASKED_TOKEN && accessToken.trim()) {
        payload.access_token = accessToken.trim();
      } else if (config) {
        // Existing config — reuse stored encrypted token by decrypting on the
        // server. But our POST handler requires an access_token to verify
        // with Meta. If the user didn't change the token, we need to signal
        // that. Simplest: require token re-entry if they're updating.
        toast.error('Please re-enter the Access Token to save changes');
        setSaving(false);
        return;
      }

      const res = await fetch('/api/whatsapp/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || 'Failed to save configuration');
        setSaving(false);
        return;
      }

      // The route now returns a structured outcome:
      //   * registered=true   → number is live, events will flow
      //   * registered=false  → credentials saved but /register
      //                         failed; UI shows the specific error
      //                         and a retry path. registration_error
      //                         is human-readable from Meta.
      if (data.registered === false && data.registration_error) {
        toast.error(
          `Saved, but Meta couldn't register the number: ${data.registration_error}`,
          { duration: 12000 },
        );
      } else if (data.registration_skipped) {
        // Credentials saved + verified, but /register was skipped
        // because no PIN was supplied (e.g. a Meta test number).
        // Don't claim the number is "Live" — point at the
        // Registration status banner instead.
        toast.success(
          'Credentials saved and verified. Inbound registration was skipped (no PIN) — see Registration status below.',
          { duration: 10000 },
        );
        setPin('');
      } else {
        toast.success(
          data.phone_info?.verified_name
            ? `Live — ${data.phone_info.verified_name} can now receive events.`
            : 'WhatsApp connected. Events will start flowing within a minute.',
        );
        // Clear the PIN so subsequent saves don't accidentally
        // re-register (which would void the active subscription if
        // the PIN became stale).
        setPin('');
      }

      if (accountId) await fetchConfig(accountId);
    } catch (err) {
      console.error('Save error:', err);
      toast.error('Failed to save configuration');
    } finally {
      setSaving(false);
    }
  }

  async function handleTestConnection() {
    if (provider === 'uazapi') {
      try {
        setTesting(true);
        const res = await fetch('/api/whatsapp/config/uazapi', { method: 'GET' });
        const payload = await res.json();
        setUazapiConnected(Boolean(payload.connected));
        if (payload.phone) setUazapiPhone(payload.phone);
        setConnectionStatus(payload.connected ? 'connected' : 'disconnected');
        setStatusMessage(payload.message || '');
        toast[payload.connected ? 'success' : 'error'](
          payload.connected ? 'uazapi instance is connected' : payload.message || 'Not connected'
        );
      } catch (err) {
        console.error('uazapi test connection error:', err);
        setConnectionStatus('disconnected');
        toast.error('Connection test failed. Check network and try again.');
      } finally {
        setTesting(false);
      }
      return;
    }

    if (provider === 'evolution') {
      try {
        setTesting(true);
        const res = await fetch('/api/whatsapp/config/evolution', { method: 'GET' });
        const payload = await res.json();
        setEvolutionConnected(Boolean(payload.connected));
        if (payload.phone) setEvolutionPhone(payload.phone);
        setConnectionStatus(payload.connected ? 'connected' : 'disconnected');
        setStatusMessage(payload.message || '');
        toast[payload.connected ? 'success' : 'error'](
          payload.connected ? 'Evolution instance is connected' : payload.message || 'Not connected'
        );
      } catch (err) {
        console.error('Evolution test connection error:', err);
        setConnectionStatus('disconnected');
        toast.error('Connection test failed. Check network and try again.');
      } finally {
        setTesting(false);
      }
      return;
    }

    try {
      setTesting(true);
      const res = await fetch('/api/whatsapp/config', { method: 'GET' });
      const payload = await res.json();

      if (payload.connected) {
        setConnectionStatus('connected');
        setResetReason(null);
        setStatusMessage('');
        toast.success(
          payload.phone_info?.verified_name
            ? `Connected to ${payload.phone_info.verified_name}`
            : 'API connection successful'
        );
      } else {
        setConnectionStatus('disconnected');
        setResetReason(payload.needs_reset ? 'token_corrupted' : payload.reason === 'meta_api_error' ? 'meta_api_error' : null);
        setStatusMessage(payload.message || '');
        toast.error(payload.message || 'API connection failed');
      }
    } catch (err) {
      console.error('Test connection error:', err);
      setConnectionStatus('disconnected');
      toast.error('Connection test failed. Check network and try again.');
    } finally {
      setTesting(false);
    }
  }

  async function handleVerifyRegistration() {
    setVerifyingRegistration(true);
    setRegistrationProbe(null);
    try {
      const res = await fetch('/api/whatsapp/config/verify-registration', {
        method: 'GET',
      });
      const data = (await res.json()) as RegistrationProbe;
      setRegistrationProbe(data);
      if (data.live) {
        toast.success('Number is fully wired — Meta is delivering events.');
      } else {
        toast.error(
          'Number is not fully registered. See the checks below for which step failed.',
          { duration: 8000 },
        );
      }
      if (accountId) await fetchConfig(accountId);
    } catch (err) {
      console.error('verify-registration failed:', err);
      toast.error('Could not reach the verification endpoint.');
    } finally {
      setVerifyingRegistration(false);
    }
  }

  async function handleReset() {
    if (!confirm('This will delete the current WhatsApp config so you can re-enter it. Continue?')) {
      return;
    }

    try {
      setResetting(true);
      const endpoint =
        provider === 'uazapi'
          ? '/api/whatsapp/config/uazapi'
          : provider === 'evolution'
            ? '/api/whatsapp/config/evolution'
            : '/api/whatsapp/config';
      const res = await fetch(endpoint, { method: 'DELETE' });
      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || 'Failed to reset configuration');
        return;
      }

      toast.success('Configuration cleared. You can now re-enter your credentials.');
      setConfig(null);
      setPhoneNumberId('');
      setWabaId('');
      setAccessToken('');
      setVerifyToken('');
      setTokenEdited(false);
      setBaseUrl('');
      setInstanceToken('');
      setInstanceTokenEdited(false);
      setInstanceName('');
      setUazapiConnected(false);
      setUazapiPhone(null);
      setEvolutionBaseUrl('');
      setEvolutionApiKey('');
      setEvolutionApiKeyEdited(false);
      setEvolutionInstanceName('');
      setEvolutionConnected(false);
      setEvolutionPhone(null);
      setQrCode(null);
      setPairingCode(null);
      setConnectionStatus('disconnected');
      setResetReason(null);
      setStatusMessage('');
    } catch (err) {
      console.error('Reset error:', err);
      toast.error('Failed to reset configuration');
    } finally {
      setResetting(false);
    }
  }

  function stopUazapiPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  // Cleanup on unmount so a left-open Settings tab doesn't keep polling
  // after the component's gone.
  useEffect(() => stopUazapiPolling, []);

  async function handleSaveUazapi() {
    if (!baseUrl.trim()) {
      toast.error('Instance URL is required');
      return;
    }
    if (!config && (!instanceToken.trim() || !instanceTokenEdited)) {
      toast.error('Instance Token is required for initial setup');
      return;
    }
    if (instanceTokenEdited === false && instanceToken === MASKED_TOKEN) {
      toast.error('Please re-enter the Instance Token to save changes');
      return;
    }

    try {
      setSavingUazapi(true);
      const res = await fetch('/api/whatsapp/config/uazapi', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          base_url: baseUrl.trim(),
          instance_token: instanceToken.trim(),
          instance_name: instanceName.trim() || null,
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || 'Failed to save configuration');
        return;
      }

      toast.success(
        data.connected
          ? 'uazapi instance saved and already connected.'
          : 'uazapi instance saved. Click Connect to pair via QR code.'
      );
      if (accountId) await fetchConfig(accountId);
    } catch (err) {
      console.error('uazapi save error:', err);
      toast.error('Failed to save configuration');
    } finally {
      setSavingUazapi(false);
    }
  }

  async function handleConnectUazapi() {
    try {
      setConnectingUazapi(true);
      setQrCode(null);
      setPairingCode(null);
      const res = await fetch('/api/whatsapp/config/uazapi/connect', { method: 'POST' });
      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || 'Failed to start pairing');
        return;
      }

      setQrCode(data.qr_code || null);
      setPairingCode(data.pairing_code || null);

      // Poll status every 3s until connected, or for up to 2 minutes
      // (the QR/pairing code goes stale well before that, so this just
      // bounds the interval rather than being a meaningful deadline).
      stopUazapiPolling();
      let attempts = 0;
      pollRef.current = setInterval(async () => {
        attempts += 1;
        try {
          const statusRes = await fetch('/api/whatsapp/config/uazapi', { method: 'GET' });
          const statusPayload = await statusRes.json();
          if (statusPayload.connected) {
            stopUazapiPolling();
            setUazapiConnected(true);
            setUazapiPhone(statusPayload.phone || null);
            setConnectionStatus('connected');
            setQrCode(null);
            setPairingCode(null);
            toast.success('WhatsApp connected via uazapi.');
            if (accountId) await fetchConfig(accountId);
          }
        } catch (err) {
          console.error('uazapi status poll failed:', err);
        }
        if (attempts >= 40) stopUazapiPolling();
      }, 3000);
    } catch (err) {
      console.error('uazapi connect error:', err);
      toast.error('Failed to start pairing');
    } finally {
      setConnectingUazapi(false);
    }
  }

  function stopEvolutionPolling() {
    if (evolutionPollRef.current) {
      clearInterval(evolutionPollRef.current);
      evolutionPollRef.current = null;
    }
  }

  useEffect(() => stopEvolutionPolling, []);

  async function handleSaveEvolution() {
    if (!evolutionBaseUrl.trim()) {
      toast.error('Instance URL is required');
      return;
    }
    if (!evolutionInstanceName.trim()) {
      toast.error('Instance name is required');
      return;
    }
    if (!config && (!evolutionApiKey.trim() || !evolutionApiKeyEdited)) {
      toast.error('API Key is required for initial setup');
      return;
    }
    if (evolutionApiKeyEdited === false && evolutionApiKey === MASKED_TOKEN) {
      toast.error('Please re-enter the API Key to save changes');
      return;
    }

    try {
      setSavingEvolution(true);
      const res = await fetch('/api/whatsapp/config/evolution', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          base_url: evolutionBaseUrl.trim(),
          instance_name: evolutionInstanceName.trim(),
          api_key: evolutionApiKey.trim(),
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || 'Failed to save configuration');
        return;
      }

      toast.success(
        data.connected
          ? 'Evolution instance saved and already connected.'
          : 'Evolution instance saved. Click Connect to pair via QR code.'
      );
      if (accountId) await fetchConfig(accountId);
    } catch (err) {
      console.error('Evolution save error:', err);
      toast.error('Failed to save configuration');
    } finally {
      setSavingEvolution(false);
    }
  }

  async function handleConnectEvolution() {
    try {
      setConnectingEvolution(true);
      setQrCode(null);
      setPairingCode(null);
      const res = await fetch('/api/whatsapp/config/evolution/connect', { method: 'POST' });
      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || 'Failed to start pairing');
        return;
      }

      setQrCode(data.qr_code || null);
      setPairingCode(data.pairing_code || null);

      // Same polling shape as uazapi's connect flow — pairing happens
      // on the phone, so polling status is the only way the UI learns
      // it succeeded.
      stopEvolutionPolling();
      let attempts = 0;
      evolutionPollRef.current = setInterval(async () => {
        attempts += 1;
        try {
          const statusRes = await fetch('/api/whatsapp/config/evolution', { method: 'GET' });
          const statusPayload = await statusRes.json();
          if (statusPayload.connected) {
            stopEvolutionPolling();
            setEvolutionConnected(true);
            setEvolutionPhone(statusPayload.phone || null);
            setConnectionStatus('connected');
            setQrCode(null);
            setPairingCode(null);
            toast.success('WhatsApp connected via Evolution.');
            if (accountId) await fetchConfig(accountId);
          }
        } catch (err) {
          console.error('Evolution status poll failed:', err);
        }
        if (attempts >= 40) stopEvolutionPolling();
      }, 3000);
    } catch (err) {
      console.error('Evolution connect error:', err);
      toast.error('Failed to start pairing');
    } finally {
      setConnectingEvolution(false);
    }
  }

  function handleCopyWebhookUrl() {
    navigator.clipboard.writeText(webhookUrl);
    toast.success('Webhook URL copied to clipboard');
  }

  if (loading) {
    return (
      <section className="animate-in fade-in-50 duration-200">
        <SettingsPanelHead
          title={t("title")}
          description={t("description")}
        />
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-primary" />
        </div>
      </section>
    );
  }

  const showResetBanner = resetReason === 'token_corrupted';

  return (
    <section className="animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title={t("title")}
        description={t("description")}
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
      {/* Main config form */}
      <div className="space-y-6">
        {/* Provider picker — whatsapp_config is one row per account, so
            switching here changes which provider that row represents.
            Saving under the other provider overwrites/disconnects
            whichever was previously configured (see migration 037). */}
        <Card>
          <CardContent className="pt-6">
            <Label className="text-muted-foreground mb-2 block">{t('providerLabel')}</Label>
            <div className="grid gap-3 sm:grid-cols-3">
              {(['meta', 'uazapi', 'evolution'] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setProvider(p)}
                  className={
                    'flex items-start gap-3 rounded-lg border p-3 text-left transition-colors ' +
                    (provider === p
                      ? 'border-primary bg-primary/5'
                      : 'border-border bg-muted/40 hover:bg-muted')
                  }
                >
                  {p === 'meta' ? (
                    <Zap className="size-4 mt-0.5 shrink-0 text-primary" />
                  ) : (
                    <QrCode className="size-4 mt-0.5 shrink-0 text-primary" />
                  )}
                  <span>
                    <span className="block text-sm font-medium text-foreground">
                      {p === 'meta' ? t('providerMeta') : p === 'uazapi' ? t('providerUazapi') : t('providerEvolution')}
                    </span>
                    <span className="block text-xs text-muted-foreground mt-0.5">
                      {p === 'meta' ? t('providerMetaDesc') : p === 'uazapi' ? t('providerUazapiDesc') : t('providerEvolutionDesc')}
                    </span>
                  </span>
                </button>
              ))}
            </div>
            {config && config.provider && config.provider !== provider && (
              <p className="mt-3 text-xs text-amber-400 flex items-center gap-1.5">
                <AlertTriangle className="size-3.5 shrink-0" />
                {t('providerSwitchWarning')}
              </p>
            )}
          </CardContent>
        </Card>

        {/* Corrupted-token reset banner */}
        {showResetBanner && (
          <Alert className="bg-amber-950/40 border-amber-600/40">
            <div className="flex items-start gap-3">
              <AlertTriangle className="size-5 text-amber-400 mt-0.5 shrink-0" />
              <div className="flex-1">
                <AlertTitle className="text-amber-200 mb-1">
                  Stored token can&apos;t be decrypted
                </AlertTitle>
                <AlertDescription className="text-amber-100/80 text-sm">
                  {statusMessage}
                </AlertDescription>
                <Button
                  onClick={handleReset}
                  disabled={resetting}
                  size="sm"
                  className="mt-3 bg-amber-600 hover:bg-amber-700 text-white"
                >
                  {resetting ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      {t('resetting')}
                    </>
                  ) : (
                    <>
                      <RotateCcw className="size-4" />
                      {t('resetConfig')}
                    </>
                  )}
                </Button>
              </div>
            </div>
          </Alert>
        )}

        {/* Connection Status (Meta) */}
        {provider === 'meta' && (
        <Alert className="bg-card border-border">
          <div className="flex items-center gap-2">
            {connectionStatus === 'connected' ? (
              <CheckCircle2 className="size-4 text-primary" />
            ) : (
              <XCircle className="size-4 text-red-500" />
            )}
            <AlertTitle className="text-foreground mb-0">
              {connectionStatus === 'connected' ? t('credentialsValid') : t('notConnected')}
            </AlertTitle>
          </div>
          <AlertDescription className="text-muted-foreground">
            {connectionStatus === 'connected'
              ? t('connectedDesc')
              : statusMessage ||
                t('notConnectedDesc')}
          </AlertDescription>
        </Alert>
        )}

        {/* Connection Status (uazapi) */}
        {provider === 'uazapi' && config && (
          <Alert className="bg-card border-border">
            <div className="flex items-center gap-2">
              {uazapiConnected ? (
                <CheckCircle2 className="size-4 text-primary" />
              ) : (
                <XCircle className="size-4 text-red-500" />
              )}
              <AlertTitle className="text-foreground mb-0">
                {uazapiConnected ? t('uazapiConnected') : t('uazapiNotConnected')}
              </AlertTitle>
            </div>
            <AlertDescription className="text-muted-foreground">
              {uazapiConnected
                ? t('uazapiConnectedDesc', { phone: uazapiPhone || '' })
                : statusMessage || t('uazapiNotConnectedDesc')}
            </AlertDescription>
          </Alert>
        )}

        {/* Connection Status (Evolution) */}
        {provider === 'evolution' && config && (
          <Alert className="bg-card border-border">
            <div className="flex items-center gap-2">
              {evolutionConnected ? (
                <CheckCircle2 className="size-4 text-primary" />
              ) : (
                <XCircle className="size-4 text-red-500" />
              )}
              <AlertTitle className="text-foreground mb-0">
                {evolutionConnected ? t('evolutionConnected') : t('evolutionNotConnected')}
              </AlertTitle>
            </div>
            <AlertDescription className="text-muted-foreground">
              {evolutionConnected
                ? t('evolutionConnectedDesc', { phone: evolutionPhone || '' })
                : statusMessage || t('evolutionNotConnectedDesc')}
            </AlertDescription>
          </Alert>
        )}

        {/* Registration Status — the "is it actually live?" check.
            Credentials being valid is necessary but not sufficient;
            without a successful /register call the number won't
            receive inbound events. Surface this dimension separately
            so users don't trust a misleading green banner. Meta-only —
            uazapi has no register/subscribe step. */}
        {provider === 'meta' && config && (
          <Alert
            className={
              isRegistered
                ? 'bg-emerald-950/30 border-emerald-700/50'
                : 'bg-amber-950/30 border-amber-700/50'
            }
          >
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2">
                {isRegistered ? (
                  <CheckCircle2 className="size-4 text-emerald-400" />
                ) : (
                  <AlertTriangle className="size-4 text-amber-400" />
                )}
                <AlertTitle
                  className={
                    'mb-0 ' + (isRegistered ? 'text-emerald-200' : 'text-amber-200')
                  }
                >
                  {isRegistered
                    ? t('registered')
                    : t('notRegistered')}
                </AlertTitle>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleVerifyRegistration}
                disabled={verifyingRegistration}
                className="border-border bg-transparent text-foreground hover:bg-muted h-7"
              >
                {verifyingRegistration ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Zap className="size-3.5" />
                )}
                {t('verifyWithMeta')}
              </Button>
            </div>
            <AlertDescription className="text-muted-foreground mt-2 text-xs leading-relaxed">
              {isRegistered ? (
                <span
                  dangerouslySetInnerHTML={{
                    __html: t('subscribedSince', {
                      date: config.registered_at
                        ? new Date(config.registered_at).toLocaleString()
                        : t('unknownDate'),
                    }),
                  }}
                />
              ) : lastRegistrationError ? (
                <>
                  {t('lastAttemptFailed')}
                  <span className="text-red-300">
                    &quot;{lastRegistrationError}&quot;
                  </span>
                  . {t('retryHint')}
                </>
              ) : (
                <>{t('noRegistrationHint')}</>
              )}
            </AlertDescription>

            {registrationProbe && (
              <div className="mt-3 rounded border border-border bg-card/60 px-3 py-2 space-y-1.5 text-[11px]">
                <p className="font-medium text-foreground">
                  {t('diagnosticLastRun')}
                  <span className={registrationProbe.live ? 'text-emerald-400' : 'text-amber-400'}>
                    {registrationProbe.live ? t('live') : t('notLive')}
                  </span>
                </p>
                <ul className="space-y-0.5 text-muted-foreground">
                  {Object.entries(registrationProbe.checks).map(([k, v]) => (
                    <li key={k} className="flex items-center gap-1.5">
                      {v === true ? (
                        <CheckCircle2 className="size-3 text-emerald-400 shrink-0" />
                      ) : v === false ? (
                        <XCircle className="size-3 text-red-400 shrink-0" />
                      ) : (
                        <span className="size-3 rounded-full border border-border shrink-0" />
                      )}
                      <code className="text-muted-foreground">{k}</code>
                    </li>
                  ))}
                </ul>
                {(registrationProbe.errors ?? []).length > 0 && (
                  <ul className="pt-1 space-y-0.5 text-red-300">
                    {registrationProbe.errors?.map((e, i) => (
                      <li key={i}>• {e}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </Alert>
        )}

        {/* API Credentials (Meta) */}
        {provider === 'meta' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">{t('apiCredentialsTitle')}</CardTitle>
            <CardDescription className="text-muted-foreground">
              {t('apiCredentialsDesc')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('phoneNumberId')}</Label>
              <Input
                placeholder="e.g. 100234567890123"
                value={phoneNumberId}
                onChange={(e) => setPhoneNumberId(e.target.value)}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('wabaId')}</Label>
              <Input
                placeholder="e.g. 100234567890456"
                value={wabaId}
                onChange={(e) => setWabaId(e.target.value)}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('accessToken')}</Label>
              <div className="relative">
                <Input
                  type={showToken ? 'text' : 'password'}
                  placeholder={t('accessTokenPlaceholder')}
                  value={accessToken}
                  onChange={(e) => {
                    setAccessToken(e.target.value);
                    setTokenEdited(true);
                  }}
                  onFocus={() => {
                    if (accessToken === MASKED_TOKEN) {
                      setAccessToken('');
                      setTokenEdited(true);
                    }
                  }}
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowToken(!showToken)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                >
                  {showToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
              {config && !tokenEdited && (
                <p className="text-xs text-muted-foreground">
                  {t('tokenHidden')}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('webhookVerifyToken')}</Label>
              <Input
                placeholder={t('webhookVerifyTokenPlaceholder')}
                value={verifyToken}
                onChange={(e) => setVerifyToken(e.target.value)}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
              <p className="text-xs text-muted-foreground">
                {t('webhookVerifyTokenHint')}
              </p>
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">
                {t('twoStepPin')}
                <span className="ml-1 text-muted-foreground">{t('optional')}</span>
              </Label>
              <Input
                type="text"
                inputMode="numeric"
                maxLength={6}
                placeholder={t('pinPlaceholder')}
                value={pin}
                onChange={(e) =>
                  setPin(e.target.value.replace(/\D/g, '').slice(0, 6))
                }
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground tracking-widest"
              />
              <p className="text-xs text-muted-foreground leading-relaxed">
                <span dangerouslySetInnerHTML={{ __html: t('pinHint') }} />
              </p>
            </div>
          </CardContent>
        </Card>
        )}

        {/* Webhook URL (Meta) — uazapi's inbound webhook isn't wired up
            yet, so this is Meta-only for now. */}
        {provider === 'meta' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">{t('webhookTitle')}</CardTitle>
            <CardDescription className="text-muted-foreground">
              {t('webhookDesc')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('webhookUrl')}</Label>
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={webhookUrl}
                  className="bg-muted border-border text-muted-foreground font-mono text-sm"
                />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={handleCopyWebhookUrl}
                  className="shrink-0 border-border text-muted-foreground hover:text-foreground hover:bg-muted"
                >
                  <Copy className="size-4" />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
        )}

        {/* uazapi Instance — credentials + QR pairing */}
        {provider === 'uazapi' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">{t('uazapiCredentialsTitle')}</CardTitle>
            <CardDescription className="text-muted-foreground">
              {t('uazapiCredentialsDesc')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('uazapiBaseUrl')}</Label>
              <Input
                placeholder={t('uazapiBaseUrlPlaceholder')}
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('uazapiInstanceToken')}</Label>
              <div className="relative">
                <Input
                  type={showToken ? 'text' : 'password'}
                  placeholder={t('uazapiInstanceTokenPlaceholder')}
                  value={instanceToken}
                  onChange={(e) => {
                    setInstanceToken(e.target.value);
                    setInstanceTokenEdited(true);
                  }}
                  onFocus={() => {
                    if (instanceToken === MASKED_TOKEN) {
                      setInstanceToken('');
                      setInstanceTokenEdited(true);
                    }
                  }}
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowToken(!showToken)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                >
                  {showToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
              {config?.provider === 'uazapi' && !instanceTokenEdited && (
                <p className="text-xs text-muted-foreground">{t('tokenHidden')}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('uazapiInstanceName')}</Label>
              <Input
                placeholder={t('uazapiInstanceNamePlaceholder')}
                value={instanceName}
                onChange={(e) => setInstanceName(e.target.value)}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>

            <div className="flex flex-wrap gap-3 pt-2">
              <Button
                onClick={handleSaveUazapi}
                disabled={savingUazapi}
                className="bg-primary hover:bg-primary/90 text-primary-foreground"
              >
                {savingUazapi ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    {t('saving')}
                  </>
                ) : (
                  t('uazapiSaveCredentials')
                )}
              </Button>
              <Button
                variant="outline"
                onClick={handleConnectUazapi}
                disabled={connectingUazapi || !config}
                className="border-border text-muted-foreground hover:text-foreground hover:bg-muted"
              >
                {connectingUazapi ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    {t('uazapiConnecting')}
                  </>
                ) : (
                  <>
                    <QrCode className="size-4" />
                    {t('uazapiConnect')}
                  </>
                )}
              </Button>
            </div>

            {(qrCode || pairingCode) && (
              <div className="mt-4 flex flex-col items-center gap-3 rounded-lg border border-border bg-muted/40 p-4">
                {qrCode && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={qrCode.startsWith('data:') ? qrCode : `data:image/png;base64,${qrCode}`}
                    alt="uazapi pairing QR code"
                    className="size-48 rounded bg-white p-2"
                  />
                )}
                {pairingCode && (
                  <code className="text-lg tracking-widest text-foreground">{pairingCode}</code>
                )}
                <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                  <Smartphone className="size-3.5 shrink-0" />
                  {t('uazapiScanQr')}
                </p>
                <p className="text-xs text-primary flex items-center gap-1.5">
                  <Loader2 className="size-3 animate-spin" />
                  {t('uazapiWaitingForScan')}
                </p>
              </div>
            )}
          </CardContent>
        </Card>
        )}

        {/* Evolution Instance — credentials + QR pairing */}
        {provider === 'evolution' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">{t('evolutionCredentialsTitle')}</CardTitle>
            <CardDescription className="text-muted-foreground">
              {t('evolutionCredentialsDesc')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('evolutionBaseUrl')}</Label>
              <Input
                placeholder={t('evolutionBaseUrlPlaceholder')}
                value={evolutionBaseUrl}
                onChange={(e) => setEvolutionBaseUrl(e.target.value)}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('evolutionInstanceName')}</Label>
              <Input
                placeholder={t('evolutionInstanceNamePlaceholder')}
                value={evolutionInstanceName}
                onChange={(e) => setEvolutionInstanceName(e.target.value)}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('evolutionApiKey')}</Label>
              <div className="relative">
                <Input
                  type={showToken ? 'text' : 'password'}
                  placeholder={t('evolutionApiKeyPlaceholder')}
                  value={evolutionApiKey}
                  onChange={(e) => {
                    setEvolutionApiKey(e.target.value);
                    setEvolutionApiKeyEdited(true);
                  }}
                  onFocus={() => {
                    if (evolutionApiKey === MASKED_TOKEN) {
                      setEvolutionApiKey('');
                      setEvolutionApiKeyEdited(true);
                    }
                  }}
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowToken(!showToken)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                >
                  {showToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
              {config?.provider === 'evolution' && !evolutionApiKeyEdited && (
                <p className="text-xs text-muted-foreground">{t('tokenHidden')}</p>
              )}
              <p className="text-xs text-muted-foreground">{t('evolutionApiKeyHint')}</p>
            </div>

            <div className="flex flex-wrap gap-3 pt-2">
              <Button
                onClick={handleSaveEvolution}
                disabled={savingEvolution}
                className="bg-primary hover:bg-primary/90 text-primary-foreground"
              >
                {savingEvolution ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    {t('saving')}
                  </>
                ) : (
                  t('evolutionSaveCredentials')
                )}
              </Button>
              <Button
                variant="outline"
                onClick={handleConnectEvolution}
                disabled={connectingEvolution || !config}
                className="border-border text-muted-foreground hover:text-foreground hover:bg-muted"
              >
                {connectingEvolution ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    {t('evolutionConnecting')}
                  </>
                ) : (
                  <>
                    <QrCode className="size-4" />
                    {t('evolutionConnect')}
                  </>
                )}
              </Button>
            </div>

            {(qrCode || pairingCode) && (
              <div className="mt-4 flex flex-col items-center gap-3 rounded-lg border border-border bg-muted/40 p-4">
                {qrCode && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={qrCode.startsWith('data:') ? qrCode : `data:image/png;base64,${qrCode}`}
                    alt="Evolution pairing QR code"
                    className="size-48 rounded bg-white p-2"
                  />
                )}
                {pairingCode && (
                  <code className="text-lg tracking-widest text-foreground">{pairingCode}</code>
                )}
                <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                  <Smartphone className="size-3.5 shrink-0" />
                  {t('evolutionScanQr')}
                </p>
                <p className="text-xs text-primary flex items-center gap-1.5">
                  <Loader2 className="size-3 animate-spin" />
                  {t('evolutionWaitingForScan')}
                </p>
              </div>
            )}
          </CardContent>
        </Card>
        )}

        {/* Action Buttons */}
        <div className="flex flex-wrap gap-3">
          {provider === 'meta' && (
          <Button
            onClick={handleSave}
            disabled={saving}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            {saving ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t('saving')}
              </>
            ) : (
              t('saveConfig')
            )}
          </Button>
          )}
          <Button
            variant="outline"
            onClick={handleTestConnection}
            disabled={testing || !config}
            className="border-border text-muted-foreground hover:text-foreground hover:bg-muted"
          >
            {testing ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t('testing')}
              </>
            ) : (
              <>
                <Zap className="size-4" />
                {t('testConnection')}
              </>
            )}
          </Button>
          {config && (
            <Button
              variant="outline"
              onClick={handleReset}
              disabled={resetting}
              className="border-red-900 text-red-400 hover:text-red-300 hover:bg-red-950/40"
            >
              {resetting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('resetting')}
                </>
              ) : (
                <>
                  <RotateCcw className="size-4" />
                  {t('resetConfig')}
                </>
              )}
            </Button>
          )}
        </div>
      </div>

      {/* Setup Instructions Sidebar */}
      <div>
        {provider === 'uazapi' ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-foreground text-base">{t('setupInstructions')}</CardTitle>
              <CardDescription className="text-muted-foreground">
                {t('uazapiCredentialsDesc')}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <ol className="list-decimal list-inside space-y-2 text-sm text-muted-foreground">
                <li>{t('uazapiBaseUrl')} + {t('uazapiInstanceToken')}</li>
                <li>{t('uazapiSaveCredentials')}</li>
                <li>{t('uazapiConnect')}</li>
                <li>{t('uazapiScanQr')}</li>
              </ol>
              <p className="text-xs text-muted-foreground pt-2 border-t border-border">
                {t('uazapiTemplatesHidden')}
              </p>
            </CardContent>
          </Card>
        ) : provider === 'evolution' ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-foreground text-base">{t('setupInstructions')}</CardTitle>
              <CardDescription className="text-muted-foreground">
                {t('evolutionCredentialsDesc')}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <ol className="list-decimal list-inside space-y-2 text-sm text-muted-foreground">
                <li>{t('evolutionBaseUrl')} + {t('evolutionInstanceName')} + {t('evolutionApiKey')}</li>
                <li>{t('evolutionSaveCredentials')}</li>
                <li>{t('evolutionConnect')}</li>
                <li>{t('evolutionScanQr')}</li>
              </ol>
              <p className="text-xs text-muted-foreground pt-2 border-t border-border">
                {t('evolutionTemplatesHidden')}
              </p>
            </CardContent>
          </Card>
        ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground text-base">{t('setupInstructions')}</CardTitle>
            <CardDescription className="text-muted-foreground">
              {t('setupInstructionsDesc')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Accordion>
              <AccordionItem className="border-border">
                <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                  <span className="flex items-center gap-2">
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">1</span>
                    {t('step1')}
                  </span>
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground">
                  <ol className="list-decimal list-inside space-y-1 text-sm">
                    <li dangerouslySetInnerHTML={{ __html: t('step1_1') }} />
                    <li>{t('step1_2')}</li>
                    <li>{t('step1_3')}</li>
                    <li>{t('step1_4')}</li>
                  </ol>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem className="border-border">
                <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                  <span className="flex items-center gap-2">
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">2</span>
                    {t('step2')}
                  </span>
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground">
                  <ol className="list-decimal list-inside space-y-1 text-sm">
                    <li>{t('step2_1')}</li>
                    <li>{t('step2_2')}</li>
                    <li>{t('step2_3')}</li>
                  </ol>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem className="border-border">
                <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                  <span className="flex items-center gap-2">
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">3</span>
                    {t('step3')}
                  </span>
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground">
                  <ol className="list-decimal list-inside space-y-1 text-sm">
                    <li>{t('step3_1')}</li>
                    <li dangerouslySetInnerHTML={{ __html: t('step3_2') }} />
                    <li dangerouslySetInnerHTML={{ __html: t('step3_3') }} />
                    <li dangerouslySetInnerHTML={{ __html: t('step3_4') }} />
                  </ol>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem className="border-border">
                <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                  <span className="flex items-center gap-2">
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">4</span>
                    {t('step4')}
                  </span>
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground">
                  <ol className="list-decimal list-inside space-y-1 text-sm">
                    <li>{t('step4_1')}</li>
                    <li>{t('step4_2')}</li>
                    <li dangerouslySetInnerHTML={{ __html: t('step4_3') }} />
                    <li dangerouslySetInnerHTML={{ __html: t('step4_4') }} />
                    <li>{t('step4_5')}</li>
                  </ol>
                </AccordionContent>
              </AccordionItem>
            </Accordion>

            <div className="mt-4 pt-4 border-t border-border">
              <a
                href="https://developers.facebook.com/docs/whatsapp/cloud-api/get-started"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-primary hover:text-primary/80 transition-colors"
              >
                <ExternalLink className="size-3.5" />
                {t('metaDocs')}
              </a>
            </div>
          </CardContent>
        </Card>
        )}
      </div>
    </div>
    </section>
  );
}
