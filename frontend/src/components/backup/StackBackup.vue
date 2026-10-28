<template>
    <div class="stack-backup-view my-3">
        <!-- Notification Banner if PBS is not configured -->
        <div v-if="!pbsConfigured" class="alert alert-warning mb-4">
            <font-awesome-icon icon="exclamation-circle" class="me-2" />
            {{ $t("Proxmox Backup Server is not yet enabled or configured.") }}
            <router-link to="/settings/backup" class="alert-link ms-2">
                {{ $t("Configure PBS in Settings") }} &rarr;
            </router-link>
        </div>

        <div class="row">
            <!-- Left Column: Backup Configuration & Manual Trigger -->
            <div class="col-lg-6 mb-4">
                <!-- Stack Backup Settings Box -->
                <div class="shadow-box big-padding mb-4">
                    <h4 class="mb-3 d-flex align-items-center">
                        <font-awesome-icon icon="cloud-arrow-down" class="text-primary me-2" />
                        {{ $t("Stack Backup Configuration") }}
                    </h4>

                    <!-- Container Services in this Stack -->
                    <div v-if="services && services.length > 0" class="mb-3">
                        <label class="form-label text-secondary small fw-bold">{{ $t("Containers in this Stack") }}</label>
                        <div class="d-flex flex-wrap gap-1">
                            <span v-for="s in services" :key="s" class="badge bg-secondary">
                                {{ s }}
                            </span>
                        </div>
                    </div>

                    <!-- Backup Container Mode -->
                    <div class="mb-4">
                        <label class="form-label fw-bold">{{ $t("Container State During Backup") }}</label>
                        <select v-model="config.containerMode" class="form-select">
                            <option value="none">
                                {{ $t("Live (No downtime - default)") }}
                            </option>
                            <option value="pause">
                                {{ $t("Pause Containers (Freezes memory/state during archiving)") }}
                            </option>
                            <option value="stop">
                                {{ $t("Stop / Restart Containers (Crash-consistent database backup)") }}
                            </option>
                        </select>
                        <div class="form-text">
                            {{ $t("Defines how containers in this stack transition during archive creation.") }}
                        </div>
                    </div>

                    <!-- Enable Stack Schedule Switch -->
                    <div class="form-check form-switch mb-3">
                        <input
                            id="stackBackupEnabled"
                            v-model="config.enabled"
                            class="form-check-input"
                            type="checkbox"
                        />
                        <label class="form-check-label fw-bold" for="stackBackupEnabled">
                            {{ $t("Enable Automated Backup for this Stack") }}
                        </label>
                    </div>

                    <!-- Schedule Selector -->
                    <div v-if="config.enabled" class="mb-4 ps-3 border-start border-3 border-primary">
                        <label class="form-label fw-bold">{{ $t("Schedule Frequency") }}</label>
                        <div class="d-flex gap-2 mb-3">
                            <button
                                type="button"
                                class="btn btn-sm"
                                :class="schedulePreset === 'global' ? 'btn-primary' : 'btn-outline-secondary'"
                                @click="selectPreset('global')"
                            >
                                {{ $t("Inherit Global") }}
                            </button>
                            <button
                                type="button"
                                class="btn btn-sm"
                                :class="schedulePreset === 'daily' ? 'btn-primary' : 'btn-outline-secondary'"
                                @click="selectPreset('daily')"
                            >
                                {{ $t("Daily") }}
                            </button>
                            <button
                                type="button"
                                class="btn btn-sm"
                                :class="schedulePreset === 'weekly' ? 'btn-primary' : 'btn-outline-secondary'"
                                @click="selectPreset('weekly')"
                            >
                                {{ $t("Weekly") }}
                            </button>
                            <button
                                type="button"
                                class="btn btn-sm"
                                :class="schedulePreset === 'custom' ? 'btn-primary' : 'btn-outline-secondary'"
                                @click="selectPreset('custom')"
                            >
                                {{ $t("Custom Cron") }}
                            </button>
                        </div>

                        <div v-if="schedulePreset === 'custom'" class="mb-3">
                            <label class="form-label small" for="stackCron">{{ $t("Cron Expression") }}</label>
                            <input
                                id="stackCron"
                                v-model="config.cron"
                                type="text"
                                class="form-control form-control-sm"
                                placeholder="0 2 * * *"
                            />
                        </div>
                        <div v-else-if="schedulePreset === 'global'" class="small text-secondary mb-2">
                            {{ $t("Runs automatically with the global PBS backup schedule.") }}
                        </div>
                    </div>

                    <!-- Include volumes and bind mounts -->
                    <div class="form-check mb-3">
                        <input
                            id="includeVolumesCheck"
                            v-model="config.includeVolumes"
                            class="form-check-input"
                            type="checkbox"
                        />
                        <label class="form-check-label" for="includeVolumesCheck">
                            {{ $t("Include named Docker volumes and external bind-mounts") }}
                        </label>
                    </div>

                    <!-- Detected Volumes List -->
                    <div v-if="volumeInspection && volumeInspection.volumes.length > 0" class="mb-4">
                        <label class="form-label text-secondary small fw-bold d-flex justify-content-between align-items-center">
                            <span>{{ $t("Detected Stack Volumes & Mounts") }}</span>
                            <button
                                type="button"
                                class="btn btn-link btn-sm p-0 text-decoration-none"
                                @click="inspectVolumes"
                            >
                                <font-awesome-icon icon="arrows-rotate" class="me-1" />
                                {{ $t("Re-scan") }}
                            </button>
                        </label>
                        <div class="list-group list-group-flush border volume-list">
                            <div
                                v-for="(vol, i) in volumeInspection.volumes"
                                :key="i"
                                class="list-group-item d-flex justify-content-between align-items-center py-2 px-3 bg-transparent"
                            >
                                <div class="small text-truncate me-2">
                                    <span
                                        class="badge me-2"
                                        :class="getVolumeKindBadgeClass(vol.kind)"
                                    >
                                        {{ formatVolumeKind(vol.kind) }}
                                    </span>
                                    <span
                                        v-if="vol.isExternalResource"
                                        class="badge bg-secondary me-2"
                                    >
                                        external: true
                                    </span>
                                    <code>{{ vol.source }}</code>
                                    <span class="text-secondary mx-1">&rarr;</span>
                                    <code class="text-secondary">{{ vol.target }}</code>
                                </div>
                                <span
                                    v-if="vol.isAccessible"
                                    class="badge bg-success"
                                    :title="vol.hostPath"
                                >
                                    <font-awesome-icon icon="check-circle" class="me-1" />
                                    {{ $t("Mounted") }}
                                </span>
                                <span
                                    v-else
                                    class="badge bg-danger"
                                    :title="vol.hostPath"
                                >
                                    <font-awesome-icon icon="exclamation-circle" class="me-1" />
                                    {{ $t("Unmounted") }}
                                </span>
                            </div>
                        </div>
                    </div>

                    <!-- External Networks / Volumes Dependency Hint -->
                    <div
                        v-if="volumeInspection && volumeInspection.preStartCommands && volumeInspection.preStartCommands.length > 0"
                        class="alert alert-info mb-4"
                    >
                        <div class="fw-bold mb-1">
                            <font-awesome-icon icon="info-circle" class="me-1" />
                            {{ $t("External Resources Required on New Host") }}
                        </div>
                        <p class="small mb-2">
                            {{ $t("This stack references external networks or volumes (external: true). Before starting this stack after restoring on a new host, run:") }}
                        </p>
                        <pre class="p-2 bg-black text-light small mb-0 snippet-box">{{ volumeInspection.preStartCommands.join("\n") }}</pre>
                    </div>

                    <!-- Unresolved Environment Variable Error -->
                    <div
                        v-if="volumeInspection && volumeInspection.unresolvedVariables && volumeInspection.unresolvedVariables.length > 0"
                        class="alert alert-danger mb-4"
                    >
                        <div class="fw-bold mb-1">
                            <font-awesome-icon icon="exclamation-circle" class="me-1" />
                            {{ $t("Unresolved Environment Variables in Volumes") }}
                        </div>
                        <p class="small mb-1">
                            {{ $t("The following volume paths contain undefined .env variables and will block backup until resolved:") }}
                        </p>
                        <ul class="small mb-0">
                            <li v-for="(u, idx) in volumeInspection.unresolvedVariables" :key="idx">
                                <code>{{ u }}</code>
                            </li>
                        </ul>
                    </div>

                    <!-- Incomplete Backup Warning when unmounted paths exist -->
                    <div
                        v-if="config.includeVolumes && hasMissingMounts"
                        class="alert alert-warning mb-4"
                    >
                        <div class="fw-bold mb-1">
                            <font-awesome-icon icon="exclamation-triangle" class="me-1" />
                            {{ $t("Unmounted Volume Paths Detected") }}
                        </div>
                        <p class="small mb-2">
                            {{ $t("This stack uses named volumes or host paths that are not currently mounted inside the Dockge container. To back them up, add the following to Dockge's own compose.yaml:") }}
                        </p>
                        <pre class="p-2 bg-black text-light small mb-2 snippet-box">{{ volumeInspection.recommendedComposeSnippet }}</pre>
                        <div class="form-check mt-2">
                            <input
                                id="allowIncompleteBackupCheck"
                                v-model="allowIncompleteBackup"
                                class="form-check-input"
                                type="checkbox"
                            />
                            <label class="form-check-label small fw-bold text-danger" for="allowIncompleteBackupCheck">
                                {{ $t("I understand these unmounted volumes will be skipped (allow incomplete backup)") }}
                            </label>
                        </div>
                    </div>

                    <!-- Actions -->
                    <div class="d-flex gap-2">
                        <button
                            class="btn btn-primary"
                            type="button"
                            :disabled="savingConfig"
                            @click="saveConfig"
                        >
                            <font-awesome-icon v-if="savingConfig" icon="spinner" spin class="me-1" />
                            <font-awesome-icon v-else icon="save" class="me-1" />
                            {{ $t("Save Settings") }}
                        </button>

                        <button
                            class="btn btn-outline-primary"
                            type="button"
                            :disabled="backingUp || !pbsConfigured || (config.includeVolumes && hasMissingMounts && !allowIncompleteBackup)"
                            @click="triggerBackup"
                        >
                            <font-awesome-icon v-if="backingUp" icon="spinner" spin class="me-1" />
                            <font-awesome-icon v-else icon="play" class="me-1" />
                            {{ $t("Backup Stack Now") }}
                        </button>
                    </div>
                </div>

                <!-- Live Progress Output -->
                <div v-if="logs.length > 0 || backingUp" class="shadow-box big-padding">
                    <h5 class="mb-2 d-flex justify-content-between align-items-center">
                        <span>
                            <font-awesome-icon icon="terminal" class="me-2 text-info" />
                            {{ $t("Backup / Restore Progress") }}
                        </span>
                        <button class="btn btn-sm btn-outline-secondary" @click="logs = []">
                            {{ $t("Clear") }}
                        </button>
                    </h5>
                    <div ref="logBox" class="terminal-box p-3 bg-black text-light">
                        <div v-for="(log, idx) in logs" :key="idx" :class="getLogClass(log.type)">
                            <span class="text-secondary small me-2">[{{ formatTime(log.timestamp) }}]</span>
                            <span>{{ log.text }}</span>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Right Column: Snapshots & Restore for this Stack -->
            <div class="col-lg-6">
                <div class="shadow-box big-padding mb-4">
                    <div class="d-flex justify-content-between align-items-center mb-3">
                        <h4 class="mb-0 d-flex align-items-center">
                            <font-awesome-icon icon="list" class="text-primary me-2" />
                            {{ $t("Snapshots for") }} {{ stackName }}
                        </h4>
                        <button
                            class="btn btn-sm btn-outline-primary"
                            :disabled="loadingSnapshots || !pbsConfigured"
                            @click="loadSnapshots"
                        >
                            <font-awesome-icon v-if="loadingSnapshots" icon="spinner" spin class="me-1" />
                            <font-awesome-icon v-else icon="arrows-rotate" class="me-1" />
                            {{ $t("Refresh") }}
                        </button>
                    </div>

                    <div v-if="snapshots.length === 0" class="text-center py-4 text-secondary">
                        <font-awesome-icon icon="info-circle" class="fa-2x mb-2" />
                        <div>{{ $t("No snapshots available for this stack yet.") }}</div>
                    </div>

                    <div v-else class="table-responsive">
                        <table class="table table-hover align-middle mb-0">
                            <thead>
                                <tr>
                                    <th>{{ $t("Date & Time") }}</th>
                                    <th>{{ $t("Snapshot ID") }}</th>
                                    <th>{{ $t("Size") }}</th>
                                    <th class="text-end">{{ $t("Action") }}</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr v-for="snap in snapshots" :key="snap.snapshotId">
                                    <td>
                                        <strong>{{ formatDate(snap.backupTimeISO) }}</strong>
                                    </td>
                                    <td>
                                        <code class="small">{{ snap.snapshotId }}</code>
                                    </td>
                                    <td>{{ formatSize(snap.size) }}</td>
                                    <td class="text-end">
                                        <button
                                            class="btn btn-sm btn-outline-primary"
                                            :disabled="backingUp || restoring"
                                            @click="openRestore(snap)"
                                        >
                                            <font-awesome-icon icon="cloud-arrow-down" class="me-1" />
                                            {{ $t("Restore") }}
                                        </button>
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        </div>

        <!-- Restore Confirmation Modal -->
        <PbsRestoreModal
            :show="showRestoreModal"
            :snapshot="selectedSnapshot"
            :default-stack-name="stackName"
            @close="showRestoreModal = false"
            @restore-started="onRestoreStarted"
        />
    </div>
</template>

<script>
import PbsRestoreModal from "./PbsRestoreModal.vue";

export default {
    name: "StackBackup",
    components: {
        PbsRestoreModal,
    },
    props: {
        stackName: {
            type: String,
            required: true,
        },
        endpoint: {
            type: String,
            default: "",
        },
        services: {
            type: Array,
            default: () => [],
        },
    },
    emits: [ "close" ],
    data() {
        return {
            pbsConfigured: false,
            savingConfig: false,
            loadingSnapshots: false,
            backingUp: false,
            restoring: false,
            showRestoreModal: false,
            selectedSnapshot: null,
            schedulePreset: "global",
            allowIncompleteBackup: false,
            volumeInspection: null,
            config: {
                enabled: true,
                containerMode: "none",
                cron: "",
                includeVolumes: true,
            },
            snapshots: [],
            logs: [],
        };
    },
    computed: {
        hasMissingMounts() {
            return Boolean(
                this.volumeInspection &&
                Array.isArray(this.volumeInspection.missingMounts) &&
                this.volumeInspection.missingMounts.length > 0
            );
        },
    },
    watch: {
        stackName() {
            this.loadAll();
        },
        logs: {
            handler() {
                this.$nextTick(() => {
                    const el = this.$refs.logBox;
                    if (el) {
                        el.scrollTop = el.scrollHeight;
                    }
                });
            },
            deep: true,
        },
    },
    mounted() {
        this.loadAll();

        const socket = this.$root.getSocket();
        socket.on("pbsLog", (logEvent) => {
            this.logs.push(logEvent);
        });

        socket.on("pbsBackupFinished", (res) => {
            this.backingUp = false;
            this.loadSnapshots();
            if (res.ok) {
                this.$root.toastSuccess(res.message);
            } else {
                this.$root.toastError(res.message);
            }
        });

        socket.on("pbsRestoreFinished", (res) => {
            this.restoring = false;
            if (res.ok) {
                this.$root.toastSuccess(res.message);
            } else {
                this.$root.toastError(res.message);
            }
        });
    },
    methods: {
        loadAll() {
            this.allowIncompleteBackup = false;
            this.checkPbsStatus();
            this.loadConfig();
            this.loadSnapshots();
            this.inspectVolumes();
        },
        checkPbsStatus() {
            this.$root.getSocket().emit("getPbsConfig", (res) => {
                if (res.ok && res.data && res.data.host) {
                    this.pbsConfigured = true;
                } else {
                    this.pbsConfigured = false;
                }
            });
        },
        inspectVolumes() {
            this.$root.getSocket().emit("inspectStackVolumes", this.stackName, (res) => {
                if (res.ok && res.data) {
                    this.volumeInspection = res.data;
                } else {
                    this.volumeInspection = null;
                }
            });
        },
        loadConfig() {
            this.$root.getSocket().emit("getStackBackupConfig", this.stackName, (res) => {
                if (res.ok && res.data) {
                    this.config = { ...this.config,
                        ...res.data };
                    if (!this.config.cron) {
                        this.schedulePreset = "global";
                    } else if (this.config.cron === "0 2 * * *") {
                        this.schedulePreset = "daily";
                    } else if (this.config.cron === "0 2 * * 0") {
                        this.schedulePreset = "weekly";
                    } else {
                        this.schedulePreset = "custom";
                    }
                }
            });
        },
        saveConfig() {
            this.savingConfig = true;
            this.$root.getSocket().emit("saveStackBackupConfig", this.stackName, this.config, (res) => {
                this.savingConfig = false;
                if (res.ok) {
                    this.$root.toastSuccess(res.msg);
                } else {
                    this.$root.toastError(res.msg);
                }
            });
        },
        loadSnapshots() {
            this.loadingSnapshots = true;
            this.$root.getSocket().emit("getStackSnapshots", this.stackName, (res) => {
                this.loadingSnapshots = false;
                if (res.ok && Array.isArray(res.data)) {
                    this.snapshots = res.data;
                } else {
                    this.snapshots = [];
                }
            });
        },
        selectPreset(preset) {
            this.schedulePreset = preset;
            if (preset === "global") {
                this.config.cron = "";
            } else if (preset === "daily") {
                this.config.cron = "0 2 * * *";
            } else if (preset === "weekly") {
                this.config.cron = "0 2 * * 0";
            }
        },
        triggerBackup() {
            this.backingUp = true;
            this.logs = [];
            this.$root.getSocket().emit("startPbsBackup", {
                stackName: this.stackName,
                containerMode: this.config.containerMode || "none",
                includeVolumes: this.config.includeVolumes,
                allowIncompleteBackup: this.allowIncompleteBackup,
                includeDockgeData: false,
            }, (res) => {
                if (res.ok) {
                    this.$root.toastSuccess(res.msg);
                } else {
                    this.backingUp = false;
                    this.$root.toastError(res.msg);
                }
            });
        },
        formatVolumeKind(kind) {
            if (kind === "named-volume") {
                return this.$t("Named Volume");
            }
            if (kind === "external-bind") {
                return this.$t("External Path");
            }
            return this.$t("Stack Folder");
        },
        getVolumeKindBadgeClass(kind) {
            if (kind === "named-volume") {
                return "bg-primary";
            }
            if (kind === "external-bind") {
                return "bg-info text-dark";
            }
            return "bg-secondary";
        },
        openRestore(snap) {
            this.selectedSnapshot = snap;
            this.showRestoreModal = true;
        },
        onRestoreStarted() {
            this.restoring = true;
            this.logs = [];
        },
        getLogClass(type) {
            switch (type) {
                case "stderr":
                case "error":
                    return "text-danger";
                case "info":
                    return "text-info";
                case "done":
                    return "text-success fw-bold";
                default:
                    return "text-light";
            }
        },
        formatTime(timestamp) {
            if (!timestamp) {
                return "";
            }
            return new Date(timestamp).toLocaleTimeString();
        },
        formatDate(dateStr) {
            if (!dateStr) {
                return "-";
            }
            return new Date(dateStr).toLocaleString();
        },
        formatSize(bytes) {
            if (!bytes || bytes === 0) {
                return "0 B";
            }
            const k = 1024;
            const sizes = [ "B", "KB", "MB", "GB", "TB" ];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../../styles/vars.scss";

.shadow-box {
    border-radius: 10px !important;
}

.volume-list {
    border-radius: 10px;
    overflow: hidden;
}

.snippet-box {
    border-radius: 8px;
    margin: 0;
}

.terminal-box {
    font-family: "JetBrains Mono", Consolas, monospace;
    font-size: 13px;
    max-height: 250px;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-all;
    border-radius: 10px;
}

.table {
    margin-bottom: 0;

    .dark & {
        color: $dark-font-color;
        border-color: $dark-border-color;

        th, td {
            background-color: transparent;
            color: $dark-font-color;
            border-bottom-color: $dark-border-color;
        }
    }
}
</style>
