import * as Crypto from "expo-crypto";
import { StatusBar } from "expo-status-bar";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import {
  ApiError,
  MobileApi,
  type InspectionSession,
  type MobileUser,
  type PropertyResult,
  type ReportDiscovery,
  type ReportFile,
} from "./src/api/client";
import { AuthProvider, useAuth } from "./src/auth/session";
import { loadMobileConfig, type MobileConfig } from "./src/config";
import { WORKFLOWS, type WorkflowType, workflowTitle } from "./src/domain/workflows";
import type { FieldState } from "./src/offline/model";
import { useOfflineSync } from "./src/offline/syncEngine";
import {
  OfflineStore,
  type CachedInspection,
  type LocalConflict,
  type QueueSummary,
} from "./src/offline/store";
import { PhotoCapturePanel } from "./src/photos/PhotoCapturePanel";

function friendlyError(reason: unknown) {
  const code = reason instanceof ApiError ? reason.code : reason instanceof Error ? reason.message : "request_failed";
  const messages: Record<string, string> = {
    mobile_identity_not_provisioned: "This WorkOS user has not been linked to a HomeNode appraiser yet.",
    mobile_organization_membership_required: "This user needs an active HomeNode organization membership.",
    mobile_inspection_disabled: "The mobile API is not enabled in this environment.",
    session_expired: "Your session expired. Please sign in again.",
    network_request_failed: "The HomeNode API could not be reached.",
    offline_inspection_not_found: "This inspection is not available on this device.",
  };
  return messages[code] || code.replaceAll("_", " ");
}

function Button({ title, onPress, disabled = false, secondary = false }: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  secondary?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        secondary && styles.buttonSecondary,
        disabled && styles.buttonDisabled,
        pressed && !disabled && styles.buttonPressed,
      ]}
    >
      <Text style={[styles.buttonText, secondary && styles.buttonSecondaryText]}>{title}</Text>
    </Pressable>
  );
}

function Loading({ label }: { label: string }) {
  return <View style={styles.center}><ActivityIndicator color="#1d5a43" /><Text style={styles.muted}>{label}</Text></View>;
}

function fieldStateLabel(state: FieldState) {
  if (!state.exists) return "No saved value";
  if (typeof state.value === "string") return state.value || "Empty text";
  return JSON.stringify(state.value);
}

function SignIn() {
  const auth = useAuth();
  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.signIn}>
        <Text style={styles.brand}>HomeNode</Text>
        <Text style={styles.title}>Field appraisal</Text>
        <Text style={styles.body}>Sign in with your managed HomeNode account to find a property and continue its appraisal file.</Text>
        {auth.error ? <Text style={styles.error}>{friendlyError(new Error(auth.error))}</Text> : null}
        <Button title={auth.busy ? "Signing in…" : "Sign in securely"} disabled={auth.busy} onPress={() => void auth.signIn()} />
        <Text style={styles.footnote}>Authorization code + PKCE · credentials stored in the device keychain</Text>
      </View>
    </SafeAreaView>
  );
}

function PropertyCard({ property, onPress }: { property: PropertyResult; onPress: () => void }) {
  const fileCount = Object.values(property.workflows).reduce((total, workflow) => total + workflow.count, 0);
  return (
    <Pressable style={styles.card} onPress={onPress}>
      <Text style={styles.cardTitle}>{property.address || "Address unavailable"}</Text>
      <Text style={styles.muted}>{[property.city, property.postal_code, property.county].filter(Boolean).join(" · ")}</Text>
      <View style={styles.rowBetween}>
        <Text style={styles.accountId}>{property.account_id}</Text>
        <Text style={styles.badge}>{fileCount ? `${fileCount} file${fileCount === 1 ? "" : "s"}` : "No files"}</Text>
      </View>
    </Pressable>
  );
}

function SearchScreen({ api, user, cachedInspections, online, onSelect, onResume, onSignOut }: {
  api: MobileApi;
  user: MobileUser;
  cachedInspections: CachedInspection[];
  online: boolean;
  onSelect: (property: PropertyResult) => void;
  onResume: (inspection: CachedInspection) => void;
  onSignOut: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PropertyResult[]>([]);
  const [searched, setSearched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = async () => {
    if (query.trim().length < 2) {
      setError("Enter at least two characters.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setResults(await api.searchProperties(query));
      setSearched(true);
    } catch (reason) {
      setError(friendlyError(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={styles.rowBetween}>
        <View><Text style={styles.eyebrow}>FIELD APPRAISAL</Text><Text style={styles.title}>Find a property</Text></View>
        <Pressable onPress={onSignOut}><Text style={styles.link}>Sign out</Text></Pressable>
      </View>
      <Text style={styles.muted}>Signed in as {user.displayName || user.email}</Text>
      <Text style={[styles.networkBanner, online ? styles.onlineBanner : styles.offlineBanner]}>
        {online ? "Online · pending work syncs automatically" : "Offline · saved inspections remain available"}
      </Text>
      {cachedInspections.length ? <View style={styles.list}>
        <Text style={styles.sectionTitle}>Saved on this device</Text>
        {cachedInspections.map((inspection) => (
          <Pressable
            key={inspection.session.id}
            style={styles.card}
            onPress={() => onResume(inspection)}
          >
            <View style={styles.rowBetween}>
              <Text style={styles.cardTitle}>{inspection.property.address || "Property"}</Text>
              <Text style={styles.badge}>{inspection.status.replaceAll("_", " ")}</Text>
            </View>
            <Text style={styles.muted}>{inspection.file.file_number} · {workflowTitle(inspection.file.workflow_type)}</Text>
            <Text style={styles.accountId}>{inspection.property.account_id}</Text>
          </Pressable>
        ))}
      </View> : null}
      <TextInput
        autoCapitalize="words"
        autoCorrect={false}
        onChangeText={setQuery}
        onSubmitEditing={() => void search()}
        placeholder="Address, account ID, or file number"
        returnKeyType="search"
        style={styles.input}
        value={query}
      />
      <Button title={busy ? "Searching…" : "Search HomeNode"} disabled={busy || !online} onPress={() => void search()} />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {searched && !busy && !results.length ? <Text style={styles.empty}>No matching properties found.</Text> : null}
      <View style={styles.list}>{results.map((property) => (
        <PropertyCard key={property.account_id} property={property} onPress={() => onSelect(property)} />
      ))}</View>
    </ScrollView>
  );
}

function PropertyScreen({ property, onBack, onWorkflow }: {
  property: PropertyResult;
  onBack: () => void;
  onWorkflow: (workflow: WorkflowType) => void;
}) {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Pressable onPress={onBack}><Text style={styles.link}>‹ Property search</Text></Pressable>
      <Text style={styles.title}>{property.address || "Property"}</Text>
      <Text style={styles.muted}>{[property.city, property.postal_code, property.county].filter(Boolean).join(" · ")}</Text>
      <View style={styles.factGrid}>
        <Text style={styles.fact}>Account{"\n"}<Text style={styles.factValue}>{property.account_id}</Text></Text>
        <Text style={styles.fact}>Living area{"\n"}<Text style={styles.factValue}>{property.living_area_sqft ? `${property.living_area_sqft.toLocaleString()} sf` : "—"}</Text></Text>
        <Text style={styles.fact}>Built{"\n"}<Text style={styles.factValue}>{property.year_built || "—"}</Text></Text>
        <Text style={styles.fact}>Beds / baths{"\n"}<Text style={styles.factValue}>{property.bedroom_count ?? "—"} / {property.bath_count ?? "—"}</Text></Text>
      </View>
      <Text style={styles.sectionTitle}>Choose report type</Text>
      {WORKFLOWS.map((workflow) => {
        const summary = property.workflows[workflow.type];
        return (
          <Pressable key={workflow.type} style={styles.workflowCard} onPress={() => onWorkflow(workflow.type)}>
            <View style={styles.flex}><Text style={styles.cardTitle}>{workflow.title}</Text><Text style={styles.muted}>{workflow.description}</Text></View>
            <Text style={styles.badge}>{summary.count ? `${summary.count} existing` : "New"}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

function FileCard({ file, onContinue }: { file: ReportFile; onContinue: () => void }) {
  return (
    <View style={styles.card}>
      <View style={styles.rowBetween}>
        <Text style={styles.cardTitle}>{file.file_number}</Text>
        <Text style={styles.badge}>{file.is_current ? "Current" : "Prior"}</Text>
      </View>
      <Text style={styles.muted}>Updated {new Date(file.updated_at).toLocaleDateString()}</Text>
      {file.ready_for_inspection ? <Button title="Continue this file" secondary onPress={onContinue} /> : <Text style={styles.warning}>Legacy file must be assigned to your organization before inspection.</Text>}
    </View>
  );
}

function AssignmentScreen({ api, property, workflow, user, onBack, onInspect }: {
  api: MobileApi;
  property: PropertyResult;
  workflow: WorkflowType;
  user: MobileUser;
  onBack: () => void;
  onInspect: (file: ReportFile, session: InspectionSession) => void;
}) {
  const [discovery, setDiscovery] = useState<ReportDiscovery | null>(null);
  const [organizationId, setOrganizationId] = useState(user.organizations[0]?.organizationId || "");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setBusy(true);
    setError(null);
    try {
      setDiscovery(await api.discoverFiles(property.account_id, workflow));
    } catch (reason) {
      setError(friendlyError(reason));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => { void load(); }, [property.account_id, workflow]);

  const continueFile = async (file: ReportFile) => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.startInspection(file.id);
      onInspect(file, result.session);
    } catch (reason) {
      setError(friendlyError(reason));
      setBusy(false);
    }
  };

  const create = async () => {
    if (!organizationId) {
      setError("Choose an organization before creating a file.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await api.createFile({
        organizationId,
        accountId: property.account_id,
        workflowType: workflow,
        previousReportFileId: discovery?.recommended_file?.id,
        clientRequestId: Crypto.randomUUID(),
      });
      const session = await api.startInspection(created.report_file.id);
      onInspect(created.report_file, session.session);
    } catch (reason) {
      setError(friendlyError(reason));
      setBusy(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Pressable onPress={onBack}><Text style={styles.link}>‹ Report types</Text></Pressable>
      <Text style={styles.eyebrow}>{property.address}</Text>
      <Text style={styles.title}>{workflowTitle(workflow)}</Text>
      {user.organizations.length > 1 ? <View style={styles.list}>
        <Text style={styles.label}>Organization for a new file</Text>
        {user.organizations.map((organization) => (
          <Pressable
            key={organization.organizationId}
            onPress={() => setOrganizationId(organization.organizationId)}
            style={[styles.choice, organizationId === organization.organizationId && styles.choiceSelected]}
          ><Text>{organization.displayName || organization.organizationId}</Text></Pressable>
        ))}
      </View> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {busy && !discovery ? <Loading label="Checking existing files…" /> : null}
      {discovery ? <>
        {discovery.recently_created ? <Text style={styles.notice}>A file was created recently. Continue it unless a separate assignment is required.</Text> : null}
        <View style={styles.list}>{discovery.files.map((file) => (
          <FileCard key={file.id} file={file} onContinue={() => void continueFile(file)} />
        ))}</View>
        <Button
          title={discovery.files.length ? "Create separate version" : "Create appraisal file"}
          disabled={busy}
          onPress={() => void create()}
        />
        {discovery.files.length ? <Text style={styles.footnote}>A new file receives the next workflow number and preserves the selected current file as its lineage.</Text> : null}
      </> : null}
    </ScrollView>
  );
}

function InspectionScreen({
  property,
  api,
  file,
  session,
  store,
  ownerUserId,
  online,
  syncing,
  globalSummary,
  onRefreshQueue,
  onSync,
  onBack,
}: {
  property: PropertyResult;
  api: MobileApi;
  file: ReportFile;
  session: InspectionSession;
  store: OfflineStore;
  ownerUserId: string;
  online: boolean;
  syncing: boolean;
  globalSummary: QueueSummary;
  onRefreshQueue: () => Promise<void>;
  onSync: () => Promise<void>;
  onBack: () => void;
}) {
  const [comments, setComments] = useState("");
  const [draftState, setDraftState] = useState("synchronized");
  const [conflicts, setConflicts] = useState<LocalConflict[]>([]);
  const [summary, setSummary] = useState<QueueSummary>({ pending: 0, conflicts: 0, synchronized: 0 });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadLocal = useCallback(async () => {
    const [draft, nextConflicts, nextSummary] = await Promise.all([
      store.generalComments(ownerUserId, session.id),
      store.conflicts(ownerUserId, session.id),
      store.queueSummary(ownerUserId, session.id),
    ]);
    setComments(draft.value);
    setDraftState(draft.state);
    setConflicts(nextConflicts);
    setSummary(nextSummary);
  }, [ownerUserId, session.id, store]);

  useEffect(() => { void loadLocal(); }, [globalSummary, loadLocal, syncing]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await store.queueGeneralComments(ownerUserId, session.id, comments);
      await onRefreshQueue();
      await loadLocal();
      if (online) await onSync();
      await loadLocal();
    } catch (reason) {
      setError(friendlyError(reason));
    } finally {
      setSaving(false);
    }
  };

  const resolve = async (conflict: LocalConflict, resolution: "accept_server" | "apply_mobile") => {
    setError(null);
    try {
      await store.queueConflictResolution(
        ownerUserId,
        session.id,
        conflict.clientOperationId,
        resolution,
      );
      await onRefreshQueue();
      if (online) await onSync();
      await loadLocal();
    } catch (reason) {
      setError(friendlyError(reason));
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.eyebrow}>OFFLINE FIELD INSPECTION</Text>
      <Text style={styles.title}>{property.address}</Text>
      <Text style={[styles.networkBanner, online ? styles.onlineBanner : styles.offlineBanner]}>
        {online ? "Online" : "Offline"} · {summary.pending} pending · {summary.conflicts} conflict{summary.conflicts === 1 ? "" : "s"}
      </Text>
      <View style={styles.card}>
        <Text style={styles.label}>Appraisal file</Text><Text style={styles.cardTitle}>{file.file_number}</Text>
        <Text style={styles.label}>Inspection session</Text><Text style={styles.accountId}>{session.id}</Text>
        <Text style={styles.label}>Local draft</Text><Text style={styles.badge}>{draftState.replaceAll("_", " ")}</Text>
      </View>
      <Text style={styles.sectionTitle}>Appraiser field comments</Text>
      <Text style={styles.muted}>Saved locally first. Synchronization never silently overwrites a different HomeNode value.</Text>
      <TextInput
        multiline
        onChangeText={setComments}
        placeholder="Enter on-site observations…"
        style={[styles.input, styles.textArea]}
        textAlignVertical="top"
        value={comments}
      />
      <Button title={saving ? "Saving…" : "Save offline draft"} disabled={saving} onPress={() => void save()} />
      {online && summary.pending ? <Button title={syncing ? "Synchronizing…" : "Sync now"} disabled={syncing} secondary onPress={() => void onSync()} /> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {conflicts.length ? <View style={styles.list}>
        <Text style={styles.sectionTitle}>Review conflicts</Text>
        {conflicts.map((conflict) => (
          <View style={styles.conflictCard} key={conflict.clientOperationId}>
            <Text style={styles.cardTitle}>HomeNode changed this field</Text>
            <Text style={styles.label}>HomeNode value</Text>
            <Text style={styles.body}>{fieldStateLabel(conflict.conflict.server)}</Text>
            <Text style={styles.label}>Mobile value</Text>
            <Text style={styles.body}>{fieldStateLabel(conflict.conflict.mobile)}</Text>
            <Button title="Use HomeNode value" secondary onPress={() => void resolve(conflict, "accept_server")} />
            <Button title="Keep mobile value" onPress={() => void resolve(conflict, "apply_mobile")} />
          </View>
        ))}
      </View> : null}
      <PhotoCapturePanel
        api={api}
        store={store}
        ownerUserId={ownerUserId}
        sessionId={session.id}
        workflowType={file.workflow_type}
        online={online}
      />
      <Button title="Return to property" secondary onPress={onBack} />
    </ScrollView>
  );
}

function SignedInApp({ config }: { config: MobileConfig }) {
  const auth = useAuth();
  const api = useMemo(() => new MobileApi(config, auth.getAccessToken), [auth.getAccessToken, config]);
  const [store, setStore] = useState<OfflineStore | null>(null);
  const [user, setUser] = useState<MobileUser | null>(null);
  const [cachedInspections, setCachedInspections] = useState<CachedInspection[]>([]);
  const [property, setProperty] = useState<PropertyResult | null>(null);
  const [workflow, setWorkflow] = useState<WorkflowType | null>(null);
  const [inspection, setInspection] = useState<{ file: ReportFile; session: InspectionSession } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);
  const offlineSync = useOfflineSync(store, api, user?.userId || null);

  const reloadCached = useCallback(async (nextStore = store, nextUser = user) => {
    if (!nextStore || !nextUser) return;
    setCachedInspections(await nextStore.cachedInspections(nextUser.userId));
  }, [store, user]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const nextStore = await OfflineStore.open();
        let nextUser: MobileUser | null = null;
        try {
          nextUser = await api.me();
          await nextStore.cacheUser(nextUser);
        } catch (reason) {
          nextUser = await nextStore.activeCachedUser();
          if (!nextUser) throw reason;
        }
        const inspections = await nextStore.cachedInspections(nextUser.userId);
        if (!active) return;
        setStore(nextStore);
        setUser(nextUser);
        setCachedInspections(inspections);
      } catch (reason) {
        if (active) setError(friendlyError(reason));
      } finally {
        if (active) setInitialized(true);
      }
    })();
    return () => { active = false; };
  }, [api]);

  const openInspection = async (file: ReportFile, session: InspectionSession) => {
    if (store && user && property) {
      await store.cacheInspection(user.userId, property, file, session);
      await reloadCached(store, user);
    }
    setInspection({ file, session });
  };

  const resumeInspection = (cached: CachedInspection) => {
    setProperty(cached.property);
    setWorkflow(cached.file.workflow_type);
    setInspection({ file: cached.file, session: cached.session });
  };

  const syncAndReload = async () => {
    await offlineSync.syncNow();
    await reloadCached();
  };

  if (error) return <SafeAreaView style={styles.safe}><View style={styles.signIn}><Text style={styles.error}>{error}</Text><Button title="Sign out" onPress={() => void auth.signOut()} /></View></SafeAreaView>;
  if (!initialized || !user || !store) return <SafeAreaView style={styles.safe}><Loading label="Opening encrypted field drafts…" /></SafeAreaView>;
  if (property && inspection) return <InspectionScreen
    api={api}
    property={property}
    file={inspection.file}
    session={inspection.session}
    store={store}
    ownerUserId={user.userId}
    online={offlineSync.online}
    syncing={offlineSync.syncing}
    globalSummary={offlineSync.summary}
    onRefreshQueue={offlineSync.refresh}
    onSync={syncAndReload}
    onBack={() => setInspection(null)}
  />;
  if (property && workflow) return <AssignmentScreen api={api} property={property} workflow={workflow} user={user} onBack={() => setWorkflow(null)} onInspect={(file, session) => void openInspection(file, session)} />;
  if (property) return <PropertyScreen property={property} onBack={() => setProperty(null)} onWorkflow={setWorkflow} />;
  return <SearchScreen
    api={api}
    user={user}
    cachedInspections={cachedInspections}
    online={offlineSync.online}
    onSelect={setProperty}
    onResume={resumeInspection}
    onSignOut={() => void auth.signOut()}
  />;
}

function Root({ config }: { config: MobileConfig }) {
  const auth = useAuth();
  if (!auth.ready) return <SafeAreaView style={styles.safe}><Loading label="Preparing secure sign-in…" /></SafeAreaView>;
  return auth.signedIn
    ? <SafeAreaView style={styles.safe}><SignedInApp config={config} /></SafeAreaView>
    : <SignIn />;
}

export default function App() {
  let config: MobileConfig;
  try {
    config = loadMobileConfig();
  } catch (reason) {
    return <SafeAreaView style={styles.safe}><View style={styles.signIn}><Text style={styles.brand}>HomeNode</Text><Text style={styles.error}>Configuration required: {friendlyError(reason)}</Text></View></SafeAreaView>;
  }
  return <AuthProvider config={config}><StatusBar style="dark" /><Root config={config} /></AuthProvider>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#f4f7f3" },
  content: { padding: 22, paddingTop: 54, paddingBottom: 48, backgroundColor: "#f4f7f3", minHeight: "100%" },
  signIn: { flex: 1, justifyContent: "center", padding: 30, gap: 16 },
  center: { flex: 1, minHeight: 180, alignItems: "center", justifyContent: "center", gap: 12 },
  brand: { color: "#1d5a43", fontSize: 20, fontWeight: "800", letterSpacing: 1 },
  eyebrow: { color: "#547166", fontSize: 12, fontWeight: "800", letterSpacing: 1.5, marginBottom: 6 },
  title: { color: "#17251f", fontSize: 30, fontWeight: "800", lineHeight: 36 },
  sectionTitle: { color: "#17251f", fontSize: 20, fontWeight: "800", marginTop: 28, marginBottom: 12 },
  body: { color: "#42574e", fontSize: 17, lineHeight: 25 },
  muted: { color: "#64766e", fontSize: 14, lineHeight: 20 },
  footnote: { color: "#73827c", fontSize: 12, lineHeight: 18, textAlign: "center" },
  error: { color: "#9d302a", backgroundColor: "#fbe8e5", padding: 12, borderRadius: 10, overflow: "hidden" },
  warning: { color: "#805f19", marginTop: 12 },
  notice: { color: "#2f5948", backgroundColor: "#deece5", padding: 13, borderRadius: 10, lineHeight: 20, marginVertical: 12 },
  networkBanner: { padding: 10, borderRadius: 10, marginTop: 14, overflow: "hidden", fontSize: 13, fontWeight: "700" },
  onlineBanner: { color: "#24543f", backgroundColor: "#deece5" },
  offlineBanner: { color: "#795b19", backgroundColor: "#fff2ce" },
  empty: { color: "#64766e", textAlign: "center", padding: 30 },
  link: { color: "#1d5a43", fontSize: 15, fontWeight: "700", paddingVertical: 10 },
  button: { backgroundColor: "#1d5a43", borderRadius: 12, paddingVertical: 14, paddingHorizontal: 18, alignItems: "center", marginTop: 10 },
  buttonSecondary: { backgroundColor: "#e0ece5", borderWidth: 1, borderColor: "#a9c2b5" },
  buttonDisabled: { opacity: 0.5 },
  buttonPressed: { opacity: 0.82 },
  buttonText: { color: "white", fontSize: 16, fontWeight: "800" },
  buttonSecondaryText: { color: "#1d5a43" },
  input: { backgroundColor: "white", borderWidth: 1, borderColor: "#cbd7d0", borderRadius: 12, padding: 15, fontSize: 16, marginTop: 22 },
  textArea: { minHeight: 150, lineHeight: 23 },
  list: { gap: 12, marginTop: 16 },
  card: { backgroundColor: "white", padding: 16, borderRadius: 14, borderWidth: 1, borderColor: "#dce4df", gap: 6 },
  workflowCard: { backgroundColor: "white", padding: 16, borderRadius: 14, borderWidth: 1, borderColor: "#dce4df", flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 10 },
  cardTitle: { color: "#17251f", fontSize: 17, fontWeight: "800" },
  accountId: { color: "#607269", fontSize: 12, fontFamily: "monospace", marginTop: 8 },
  badge: { color: "#1d5a43", backgroundColor: "#e0ece5", paddingHorizontal: 9, paddingVertical: 5, borderRadius: 20, overflow: "hidden", fontSize: 12, fontWeight: "700" },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 },
  flex: { flex: 1 },
  factGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 20 },
  fact: { width: "47%", color: "#697a72", backgroundColor: "white", borderRadius: 12, padding: 13, lineHeight: 22 },
  factValue: { color: "#17251f", fontSize: 16, fontWeight: "800" },
  choice: { backgroundColor: "white", borderWidth: 1, borderColor: "#cbd7d0", borderRadius: 10, padding: 13 },
  choiceSelected: { borderColor: "#1d5a43", backgroundColor: "#e0ece5" },
  conflictCard: { backgroundColor: "#fff4e1", padding: 16, borderRadius: 14, borderWidth: 1, borderColor: "#dfbd79", gap: 6 },
  label: { color: "#697a72", fontSize: 12, fontWeight: "700", marginTop: 6 },
});
