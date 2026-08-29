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
import { InspectionCompletionPanel } from "./src/completion/InspectionCompletionPanel";
import { CustomAppraisalPanel } from "./src/customAppraisal/CustomAppraisalPanel";
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
import { SketchEditorPanel, type SelectedSketchRoom } from "./src/sketch/SketchEditorPanel";
import { TargetFieldPanel } from "./src/targetFields/TargetFieldPanel";
import { COLORS } from "./src/theme";
import { UadEntityPanel } from "./src/uadEntities/UadEntityPanel";

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
  return <View style={styles.center}><ActivityIndicator color={COLORS.violet} /><Text style={styles.muted}>{label}</Text></View>;
}

const INSPECTION_TABS = Object.freeze([
  ["subject", "Subject"],
  ["sketch", "Sketch"],
  ["notes", "Field Notes"],
  ["photos", "Photos"],
  ["review", "Review"],
] as const);

type InspectionTab = typeof INSPECTION_TABS[number][0];

function InspectionDrawer({ selected, propertyAddress, fileNumber, onSelect, onClose }: {
  selected: InspectionTab;
  propertyAddress: string;
  fileNumber: string;
  onSelect: (tab: InspectionTab) => void;
  onClose: () => void;
}) {
  return (
    <View accessibilityViewIsModal style={styles.inspectionDrawer}>
      <View style={styles.drawerHeader}>
        <View style={styles.flex}>
          <Text style={styles.drawerEyebrow}>FIELD APPRAISAL</Text>
          <Text numberOfLines={2} style={styles.drawerProperty}>{propertyAddress || "Subject property"}</Text>
          <Text style={styles.drawerFile}>{fileNumber}</Text>
        </View>
        <Pressable accessibilityLabel="Close section menu" accessibilityRole="button" hitSlop={10} onPress={onClose}>
          <Text style={styles.drawerClose}>×</Text>
        </Pressable>
      </View>
      <Text style={styles.drawerSectionLabel}>SECTIONS</Text>
      {INSPECTION_TABS.map(([key, label]) => (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: key === selected }}
          key={key}
          onPress={() => onSelect(key)}
          style={[styles.drawerItem, key === selected && styles.drawerItemSelected]}
        >
          <View style={[styles.drawerIndicator, key === selected && styles.drawerIndicatorSelected]} />
          <Text style={[styles.drawerItemText, key === selected && styles.drawerItemTextSelected]}>{label}</Text>
        </Pressable>
      ))}
    </View>
  );
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
  onCompleted,
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
  onCompleted: (session: InspectionSession) => Promise<void>;
}) {
  const [comments, setComments] = useState("");
  const [draftState, setDraftState] = useState("synchronized");
  const [conflicts, setConflicts] = useState<LocalConflict[]>([]);
  const [summary, setSummary] = useState<QueueSummary>({ pending: 0, conflicts: 0, synchronized: 0 });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedSketchRoom, setSelectedSketchRoom] = useState<SelectedSketchRoom | null>(null);
  const [selectedTab, setSelectedTab] = useState<InspectionTab>("subject");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const completed = session.status === "completed";
  const selectedTabLabel = INSPECTION_TABS.find(([key]) => key === selectedTab)?.[1] || "Subject";

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
  useEffect(() => {
    setSelectedSketchRoom(null);
    setSelectedTab("subject");
    setDrawerOpen(false);
  }, [session.id]);

  const selectTab = (tab: InspectionTab) => {
    setSelectedTab(tab);
    setDrawerOpen(false);
  };

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
    <View style={styles.inspectionShell}>
      {!completed ? <View style={styles.inspectionToolbar}>
        <Pressable
          accessibilityLabel="Open appraisal sections"
          accessibilityRole="button"
          hitSlop={8}
          onPress={() => setDrawerOpen(true)}
          style={({ pressed }) => [styles.hamburgerButton, pressed && styles.buttonPressed]}
        >
          <Text style={styles.hamburgerIcon}>☰</Text>
        </Pressable>
        <Text numberOfLines={1} style={styles.toolbarTitle}>{selectedTabLabel}</Text>
      </View> : null}
      <ScrollView contentContainerStyle={[styles.content, !completed && styles.inspectionContent]}>
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
      {!completed ? <>
        <View style={[styles.tabPanel, selectedTab !== "subject" && styles.tabPanelHidden]}>
          <View style={styles.subjectOverview}>
            <View style={styles.rowBetween}>
              <Text style={styles.tabTitle}>Subject property</Text>
              <Text style={styles.badge}>{workflowTitle(file.workflow_type)}</Text>
            </View>
            <Text style={styles.cardTitle}>{property.address || "Address unavailable"}</Text>
            <Text style={styles.muted}>{[property.city, property.postal_code, property.county].filter(Boolean).join(" · ")}</Text>
            <View style={styles.subjectFacts}>
              <Text style={styles.subjectFact}>Account{"\n"}<Text style={styles.subjectFactValue}>{property.account_id}</Text></Text>
              <Text style={styles.subjectFact}>Living area{"\n"}<Text style={styles.subjectFactValue}>{property.living_area_sqft ? `${property.living_area_sqft.toLocaleString()} sf` : "—"}</Text></Text>
              <Text style={styles.subjectFact}>Built{"\n"}<Text style={styles.subjectFactValue}>{property.year_built || "—"}</Text></Text>
              <Text style={styles.subjectFact}>Beds / baths{"\n"}<Text style={styles.subjectFactValue}>{property.bedroom_count ?? "—"} / {property.bath_count ?? "—"}</Text></Text>
            </View>
          </View>
          {file.workflow_type === "custom_appraisal" ? <CustomAppraisalPanel
            api={api}
            store={store}
            ownerUserId={ownerUserId}
            sessionId={session.id}
            online={online}
            onSync={onSync}
          /> : null}
          {file.workflow_type === "uad_3_6" ? <UadEntityPanel
            api={api}
            store={store}
            ownerUserId={ownerUserId}
            sessionId={session.id}
            online={online}
            onSync={onSync}
          /> : null}
          {file.workflow_type !== "custom_appraisal" ? <TargetFieldPanel
            api={api}
            store={store}
            ownerUserId={ownerUserId}
            sessionId={session.id}
            workflowType={file.workflow_type}
            online={online}
            onSync={onSync}
          /> : null}
        </View>

        <View style={[styles.tabPanel, selectedTab !== "sketch" && styles.tabPanelHidden]}>
          <SketchEditorPanel
            api={api}
            store={store}
            ownerUserId={ownerUserId}
            sessionId={session.id}
            online={online}
            selectedRoomId={selectedSketchRoom?.id || null}
            onSelectRoom={setSelectedSketchRoom}
          />
        </View>

        <View style={[styles.tabPanel, selectedTab !== "notes" && styles.tabPanelHidden]}>
          <Text style={styles.tabTitle}>Appraiser field comments</Text>
          <TextInput
            multiline
            onChangeText={setComments}
            placeholder="Enter on-site observations…"
            style={[styles.input, styles.textArea, styles.tabInput]}
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
        </View>

        <View style={[styles.tabPanel, selectedTab !== "photos" && styles.tabPanelHidden]}>
          <PhotoCapturePanel
            api={api}
            store={store}
            ownerUserId={ownerUserId}
            sessionId={session.id}
            workflowType={file.workflow_type}
            online={online}
            selectedSketchRoom={selectedSketchRoom}
          />
        </View>

        <View style={[styles.tabPanel, selectedTab !== "review" && styles.tabPanelHidden]}>
          <InspectionCompletionPanel
            api={api}
            store={store}
            ownerUserId={ownerUserId}
            session={session}
            online={online}
            onSync={onSync}
            onCompleted={onCompleted}
          />
        </View>
      </> : <>
        <Text style={styles.notice}>This completed inspection is read-only on mobile. Start or resume another appraisal file to capture new field data.</Text>
        <InspectionCompletionPanel
          api={api}
          store={store}
          ownerUserId={ownerUserId}
          session={session}
          online={online}
          onSync={onSync}
          onCompleted={onCompleted}
        />
      </>}
      <Button title="Return to property" secondary onPress={onBack} />
      </ScrollView>
      {drawerOpen ? <>
        <Pressable
          accessibilityLabel="Close section menu"
          accessibilityRole="button"
          onPress={() => setDrawerOpen(false)}
          style={styles.drawerScrim}
        />
        <InspectionDrawer
          selected={selectedTab}
          propertyAddress={property.address || "Subject property"}
          fileNumber={file.file_number}
          onSelect={selectTab}
          onClose={() => setDrawerOpen(false)}
        />
      </> : null}
    </View>
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

  const syncAndReload = useCallback(async () => {
    await offlineSync.syncNow();
    await reloadCached();
  }, [offlineSync.syncNow, reloadCached]);

  const inspectionCompleted = useCallback(async (nextSession: InspectionSession) => {
    setInspection((current) => current ? { ...current, session: nextSession } : current);
    await reloadCached();
  }, [reloadCached]);

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
    onCompleted={inspectionCompleted}
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
  safe: { flex: 1, backgroundColor: COLORS.appBackground },
  content: { padding: 22, paddingTop: 54, paddingBottom: 48, backgroundColor: COLORS.appBackground, minHeight: "100%" },
  inspectionShell: { backgroundColor: COLORS.appBackground, flex: 1 },
  inspectionContent: { paddingTop: 18 },
  inspectionToolbar: { alignItems: "center", backgroundColor: COLORS.deepPurple, borderBottomColor: COLORS.gold, borderBottomWidth: 2, flexDirection: "row", gap: 11, minHeight: 56, paddingHorizontal: 14, zIndex: 2 },
  hamburgerButton: { alignItems: "center", backgroundColor: COLORS.violet, borderColor: COLORS.goldBright, borderRadius: 9, borderWidth: 1, height: 38, justifyContent: "center", width: 42 },
  hamburgerIcon: { color: COLORS.white, fontSize: 21, fontWeight: "800", lineHeight: 23 },
  toolbarTitle: { color: COLORS.white, flex: 1, fontSize: 17, fontWeight: "800" },
  drawerScrim: { backgroundColor: "rgba(18,13,36,0.48)", bottom: 0, left: 0, position: "absolute", right: 0, top: 0, zIndex: 20 },
  inspectionDrawer: { backgroundColor: COLORS.surfaceMuted, bottom: 0, elevation: 16, gap: 5, left: 0, paddingBottom: 24, paddingHorizontal: 14, paddingTop: 18, position: "absolute", shadowColor: COLORS.shadow, shadowOffset: { width: 3, height: 0 }, shadowOpacity: 0.22, shadowRadius: 12, top: 0, width: "78%", maxWidth: 310, zIndex: 21 },
  drawerHeader: { alignItems: "flex-start", borderBottomColor: COLORS.divider, borderBottomWidth: 1, flexDirection: "row", gap: 10, marginBottom: 12, paddingBottom: 16 },
  drawerEyebrow: { color: COLORS.goldInk, fontSize: 10, fontWeight: "800", letterSpacing: 1.2 },
  drawerProperty: { color: COLORS.deepPurple, fontSize: 18, fontWeight: "800", lineHeight: 23, marginTop: 5 },
  drawerFile: { color: COLORS.muted, fontFamily: "monospace", fontSize: 11, marginTop: 5 },
  drawerClose: { color: COLORS.textPurple, fontSize: 30, lineHeight: 31 },
  drawerSectionLabel: { color: COLORS.mutedSoft, fontSize: 10, fontWeight: "800", letterSpacing: 1.1, marginBottom: 4, marginLeft: 12 },
  drawerItem: { alignItems: "center", borderRadius: 10, flexDirection: "row", gap: 11, minHeight: 49, paddingHorizontal: 11 },
  drawerItemSelected: { backgroundColor: COLORS.goldSoft },
  drawerIndicator: { backgroundColor: COLORS.divider, borderRadius: 2, height: 24, width: 4 },
  drawerIndicatorSelected: { backgroundColor: COLORS.gold },
  drawerItemText: { color: COLORS.muted, fontSize: 15, fontWeight: "700" },
  drawerItemTextSelected: { color: COLORS.deepPurple, fontWeight: "800" },
  signIn: { flex: 1, justifyContent: "center", padding: 30, gap: 16 },
  center: { flex: 1, minHeight: 180, alignItems: "center", justifyContent: "center", gap: 12 },
  brand: { color: COLORS.violet, fontSize: 20, fontWeight: "800", letterSpacing: 1 },
  eyebrow: { color: COLORS.goldInk, fontSize: 12, fontWeight: "800", letterSpacing: 1.5, marginBottom: 6 },
  title: { color: COLORS.deepPurple, fontSize: 30, fontWeight: "800", lineHeight: 36 },
  sectionTitle: { color: COLORS.deepPurple, fontSize: 20, fontWeight: "800", marginTop: 28, marginBottom: 12 },
  body: { color: COLORS.textPurple, fontSize: 17, lineHeight: 25 },
  muted: { color: COLORS.muted, fontSize: 14, lineHeight: 20 },
  footnote: { color: COLORS.mutedSoft, fontSize: 12, lineHeight: 18, textAlign: "center" },
  error: { color: COLORS.danger, backgroundColor: COLORS.dangerSoft, padding: 12, borderRadius: 10, overflow: "hidden" },
  warning: { color: COLORS.warning, marginTop: 12 },
  notice: { color: COLORS.success, backgroundColor: COLORS.successSoft, padding: 13, borderRadius: 10, lineHeight: 20, marginVertical: 12 },
  networkBanner: { padding: 10, borderRadius: 10, marginTop: 14, overflow: "hidden", fontSize: 13, fontWeight: "700" },
  onlineBanner: { color: COLORS.success, backgroundColor: COLORS.successSoft },
  offlineBanner: { color: COLORS.warning, backgroundColor: COLORS.warningSoft },
  empty: { color: COLORS.muted, textAlign: "center", padding: 30 },
  link: { color: COLORS.violet, fontSize: 15, fontWeight: "700", paddingVertical: 10 },
  button: { alignItems: "center", backgroundColor: COLORS.violet, borderRadius: 12, elevation: 2, marginTop: 10, paddingHorizontal: 18, paddingVertical: 14, shadowColor: COLORS.violet, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.18, shadowRadius: 8 },
  buttonSecondary: { backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.gold },
  buttonDisabled: { opacity: 0.5 },
  buttonPressed: { opacity: 0.82 },
  buttonText: { color: COLORS.white, fontSize: 16, fontWeight: "800" },
  buttonSecondaryText: { color: COLORS.deepPurple },
  input: { backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.borderStrong, borderRadius: 12, padding: 15, fontSize: 16, marginTop: 22 },
  textArea: { minHeight: 150, lineHeight: 23 },
  list: { gap: 12, marginTop: 16 },
  card: { backgroundColor: COLORS.surface, padding: 16, borderRadius: 14, borderWidth: 1, borderColor: COLORS.border, gap: 6 },
  workflowCard: { backgroundColor: COLORS.surface, padding: 16, borderRadius: 14, borderWidth: 1, borderColor: COLORS.border, flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 10 },
  cardTitle: { color: COLORS.deepPurple, fontSize: 17, fontWeight: "800" },
  accountId: { color: COLORS.muted, fontSize: 12, fontFamily: "monospace", marginTop: 8 },
  badge: { color: COLORS.violet, backgroundColor: COLORS.violetSoft, paddingHorizontal: 9, paddingVertical: 5, borderRadius: 20, overflow: "hidden", fontSize: 12, fontWeight: "700" },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 },
  flex: { flex: 1 },
  factGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 20 },
  fact: { width: "47%", color: COLORS.muted, backgroundColor: COLORS.surface, borderRadius: 12, padding: 13, lineHeight: 22 },
  factValue: { color: COLORS.deepPurple, fontSize: 16, fontWeight: "800" },
  choice: { backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.borderStrong, borderRadius: 10, padding: 13 },
  choiceSelected: { borderColor: COLORS.gold, backgroundColor: COLORS.goldSoft },
  conflictCard: { backgroundColor: COLORS.goldSoft, padding: 16, borderRadius: 14, borderWidth: 1, borderColor: COLORS.gold, gap: 6 },
  label: { color: COLORS.muted, fontSize: 12, fontWeight: "700", marginTop: 6 },
  tabPanel: { marginTop: 8 },
  tabPanelHidden: { display: "none" },
  tabTitle: { color: COLORS.deepPurple, fontSize: 20, fontWeight: "800" },
  tabInput: { marginTop: 12 },
  subjectOverview: { backgroundColor: COLORS.surface, borderColor: COLORS.border, borderRadius: 14, borderWidth: 1, gap: 7, marginTop: 8, padding: 16 },
  subjectFacts: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 6 },
  subjectFact: { backgroundColor: COLORS.violetSoft, borderRadius: 9, color: COLORS.muted, fontSize: 11, lineHeight: 18, padding: 10, width: "48%" },
  subjectFactValue: { color: COLORS.deepPurple, fontSize: 14, fontWeight: "800" },
});
