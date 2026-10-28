<template>
    <div class="my-3">
        <!-- Top Operational Status & Actions Card -->
        <div class="card mb-4 border-0 shadow-sm">
            <div class="card-body">
                <div class="d-flex flex-wrap justify-content-between align-items-center gap-3">
                    <div>
                        <h4 class="mb-1 d-flex align-items-center">
                            <font-awesome-icon icon="cloud-arrow-down" class="text-primary me-2" />
                            {{ $t("Proxmox Backup Server (PBS)") }}
                        </h4>
                        <div class="text-secondary small">
                            <span v-if="status.isOperating" class="badge bg-warning text-dark me-2">
                                <font-awesome-icon icon="spinner" spin class="me-1" />
                                {{ status.currentOperation.toUpperCase() }} {{ $t("in progress...") }}
                            </span>
                            <span v-else-if="pbsConfig.enabled" class="badge bg-success me-2">
                                <font-awesome-icon icon="check-circle" class="me-1" /> {{ $t("Configured") }}
                            </span>
                            <span v-else class="badge bg-secondary me-2">
                                {{ $t("Disabled / Not Configured") }}
                            </span>

                            <span v-if="status.lastBackup" class="me-3">
                                <strong>{{ $t("Last Backup") }}:</strong>
                                <span :class="status.lastBackup.status === 'success' ? 'text-success' : 'text-danger'">
                                    {{ formatDate(status.lastBackup.timestamp) }} ({{ status.lastBackup.status }})
                                </span>
                            </span>

                            <span v-if="scheduleConfig.enabled && status.nextScheduledRun">
                                <strong>{{ $t("Next Run") }}:</strong>
                                <span class="text-primary">{{ formatDate(status.nextScheduledRun) }}</span>
                            </span>
                        </div>
                    </div>

                    <div class="d-flex gap-2">
                        <button
                            class="btn btn-outline-secondary"
                            type="button"
                            @click="showConsole = true"
                        >
                            <font-awesome-icon icon="terminal" class="me-1" />
                            {{ $t("Console") }}
                            <span v-if="logs.length > 0" class="badge bg-secondary ms-1">{{ logs.length }}</span>
                        </button>

                        <button
                            class="btn btn-primary"
                            type="button"
                            :disabled="status.isOperating || !pbsConfig.enabled || !pbsConfig.host"
                            @click="triggerManualBackup"
                        >
                            <font-awesome-icon v-if="status.isOperating" icon="spinner" spin class="me-1" />
                            <font-awesome-icon v-else icon="play" class="me-1" />
                            {{ $t("Backup Now") }}
                        </button>
                    </div>
                </div>
            </div>
        </div>

        <!-- Navigation Tabs -->
        <ul class="nav nav-pills mb-4">
            <li class="nav-item">
                <button
                    class="nav-link"
                    :class="{ active: activeTab === 'snapshots' }"
                    type="button"
                    @click="activeTab = 'snapshots'"
                >
                    <font-awesome-icon icon="list" class="me-1" />
                    {{ $t("Snapshots & Restore") }}
                    <span v-if="snapshots.length > 0" class="badge bg-secondary ms-1">{{ snapshots.length }}</span>
                </button>
            </li>
            <li class="nav-item">
                <button
                    class="nav-link"
                    :class="{ active: activeTab === 'config' }"
                    type="button"
                    @click="activeTab = 'config'"
                >
                    <font-awesome-icon icon="cog" class="me-1" />
                    {{ $t("PBS Connection") }}
                </button>
            </li>
            <li class="nav-item">
                <button
                    class="nav-link"
                    :class="{ active: activeTab === 'schedule' }"
                    type="button"
                    @click="activeTab = 'schedule'"
                >
                    <font-awesome-icon icon="arrows-rotate" class="me-1" />
                    {{ $t("Schedule & Retention") }}
                </button>
            </li>
        </ul>

        <!-- TAB 1: SNAPSHOTS & RESTORE -->
        <div v-if="activeTab === 'snapshots'">
            <div class="d-flex justify-content-between align-items-center mb-3">
                <div class="input-group w-50">
                    <span class="input-group-text"><font-awesome-icon icon="search" /></span>
                    <input
                        v-model="snapshotFilter"
                        type="text"
                        class="form-control"
                        :placeholder="$t('Filter snapshots...')"
                    />
                </div>
                <button
                    class="btn btn-outline-primary"
                    :disabled="loadingSnapshots"
                    @click="loadSnapshots"
                >
                    <font-awesome-icon v-if="loadingSnapshots" icon="spinner" spin class="me-1" />
                    <font-awesome-icon v-else icon="arrows-rotate" class="me-1" />
                    {{ $t("Refresh") }}
                </button>
            </div>

            <div v-if="filteredSnapshots.length === 0" class="alert alert-light text-center py-5 border">
                <font-awesome-icon icon="info-circle" class="text-secondary fa-2x mb-2" />
                <div class="text-secondary">
                    {{ pbsConfig.enabled ? $t("No snapshots found on Proxmox Backup Server.") : $t("Configure and enable PBS connection to view snapshots.") }}
                </div>
            </div>

            <div v-else class="table-responsive shadow-sm rounded">
                <table class="table table-hover align-middle mb-0">
                    <thead class="table-light">
                        <tr>
                            <th>{{ $t("Date & Time") }}</th>
                            <th>{{ $t("Snapshot ID") }}</th>
                            <th>{{ $t("Files") }}</th>
                            <th>{{ $t("Size") }}</th>
                            <th class="text-end">{{ $t("Actions") }}</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr v-for="snap in filteredSnapshots" :key="snap.snapshotId">
                            <td>
                                <strong>{{ formatDate(snap.backupTimeISO) }}</strong>
                            </td>
                            <td>
                                <code>{{ snap.snapshotId }}</code>
                            </td>
                            <td>
                                <span
                                    v-for="(f, i) in snap.files"
                                    :key="i"
                                    class="badge bg-secondary me-1"
                                >
                                    {{ f.filename }}
                                </span>
                            </td>
                            <td>{{ formatSize(snap.size) }}</td>
                            <td class="text-end">
                                <button
                                    class="btn btn-sm btn-outline-primary me-2"
                                    :disabled="status.isOperating"
                                    @click="openRestoreModal(snap)"
                                >
                                    <font-awesome-icon icon="cloud-arrow-down" class="me-1" />
                                    {{ $t("Restore...") }}
                                </button>
                                <button
                                    class="btn btn-sm btn-outline-danger"
                                    :disabled="status.isOperating"
                                    @click="deleteSnapshot(snap)"
                                >
                                    <font-awesome-icon icon="trash" />
                                </button>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>

        <!-- TAB 2: PBS CONFIGURATION -->
        <div v-if="activeTab === 'config'">
            <form class="card p-4 border-0 shadow-sm" @submit.prevent="savePbsConfig">
                <!-- Enabled Toggle -->
                <div class="form-check form-switch mb-4">
                    <input
                        id="pbsEnabledSwitch"
                        v-model="pbsConfig.enabled"
                        class="form-check-input"
                        type="checkbox"
                    />
                    <label class="form-check-label fw-bold" for="pbsEnabledSwitch">
                        {{ $t("Enable Proxmox Backup Server Integration") }}
                    </label>
                </div>

                <div class="row g-3 mb-3">
                    <div class="col-md-9">
                        <label class="form-label fw-bold" for="pbsHost">
                            {{ $t("Server Host / IP") }} <span class="text-danger">*</span>
                        </label>
                        <input
                            id="pbsHost"
                            v-model="pbsConfig.host"
                            type="text"
                            class="form-control"
                            placeholder="e.g. 192.168.1.50 or pbs.example.com"
                            required
                        />
                    </div>
                    <div class="col-md-3">
                        <label class="form-label fw-bold" for="pbsPort">
                            {{ $t("Port") }}
                        </label>
                        <input
                            id="pbsPort"
                            v-model.number="pbsConfig.port"
                            type="number"
                            class="form-control"
                            placeholder="8007"
                        />
                    </div>
                </div>

                <div class="row g-3 mb-3">
                    <div class="col-md-6">
                        <label class="form-label fw-bold" for="pbsDatastore">
                            {{ $t("Datastore") }} <span class="text-danger">*</span>
                        </label>
                        <input
                            id="pbsDatastore"
                            v-model="pbsConfig.datastore"
                            type="text"
                            class="form-control"
                            placeholder="e.g. backup-ds"
                            required
                        />
                    </div>
                    <div class="col-md-6">
                        <label class="form-label fw-bold" for="pbsNamespace">
                            {{ $t("Namespace (Optional)") }}
                        </label>
                        <input
                            id="pbsNamespace"
                            v-model="pbsConfig.namespace"
                            type="text"
                            class="form-control"
                            placeholder="e.g. dockge-nodes"
                        />
                    </div>
                </div>

                <div class="row g-3 mb-3">
                    <div class="col-md-6">
                        <label class="form-label fw-bold" for="pbsAuthId">
                            {{ $t("Auth ID / User / Token") }} <span class="text-danger">*</span>
                        </label>
                        <input
                            id="pbsAuthId"
                            v-model="pbsConfig.authId"
                            type="text"
                            class="form-control"
                            placeholder="e.g. dockge@pbs!backup-token or root@pam"
                            required
                        />
                        <div class="form-text">
                            {{ $t("API token (user@realm!tokenid) is strongly recommended.") }}
                        </div>
                    </div>
                    <div class="col-md-6">
                        <label class="form-label fw-bold" for="pbsSecret">
                            {{ $t("Password / API Token Secret") }}
                        </label>
                        <input
                            id="pbsSecret"
                            v-model="pbsConfig.secret"
                            type="password"
                            class="form-control"
                            :placeholder="pbsConfig.secret ? '********' : $t('Enter secret')"
                            autocomplete="new-password"
                        />
                        <div class="form-text">
                            {{ $t("Leave blank to retain previously stored secret.") }}
                        </div>
                    </div>
                </div>

                <div class="mb-3">
                    <label class="form-label fw-bold" for="pbsFingerprint">
                        {{ $t("TLS Certificate Fingerprint (SHA-256)") }}
                    </label>
                    <input
                        id="pbsFingerprint"
                        v-model="pbsConfig.fingerprint"
                        type="text"
                        class="form-control"
                        placeholder="e.g. aa:bb:cc:dd:...:zz"
                    />
                    <div class="form-text">
                        {{ $t("Required if your PBS instance uses a self-signed certificate.") }}
                    </div>
                </div>

                <div class="mb-4">
                    <label class="form-label fw-bold" for="pbsBackupId">
                        {{ $t("Backup Node Identifier") }}
                    </label>
                    <input
                        id="pbsBackupId"
                        v-model="pbsConfig.backupId"
                        type="text"
                        class="form-control"
                        placeholder="dockge"
                    />
                </div>

                <div class="d-flex gap-2">
                    <button class="btn btn-primary" type="submit" :disabled="savingConfig">
                        <font-awesome-icon v-if="savingConfig" icon="spinner" spin class="me-1" />
                        <font-awesome-icon v-else icon="save" class="me-1" />
                        {{ $t("Save PBS Configuration") }}
                    </button>
                    <button
                        class="btn btn-outline-secondary"
                        type="button"
                        :disabled="testingConnection"
                        @click="testConnection"
                    >
                        <font-awesome-icon v-if="testingConnection" icon="spinner" spin class="me-1" />
                        <font-awesome-icon v-else icon="link" class="me-1" />
                        {{ $t("Test Connection") }}
                    </button>
                </div>
            </form>
        </div>

        <!-- TAB 3: SCHEDULE & RETENTION -->
        <div v-if="activeTab === 'schedule'">
            <form class="card p-4 border-0 shadow-sm" @submit.prevent="saveSchedule">
                <!-- Enable Schedule Switch -->
                <div class="form-check form-switch mb-4">
                    <input
                        id="scheduleEnabledSwitch"
                        v-model="scheduleConfig.enabled"
                        class="form-check-input"
                        type="checkbox"
                    />
                    <label class="form-check-label fw-bold" for="scheduleEnabledSwitch">
                        {{ $t("Enable Automated Scheduled Backups") }}
                    </label>
                </div>

                <!-- Schedule Frequency Presets -->
                <div class="mb-4">
                    <label class="form-label fw-bold">{{ $t("Backup Frequency") }}</label>
                    <div class="row g-2">
                        <div class="col-md-4">
                            <div
                                class="border rounded p-3 text-center cursor-pointer"
                                :class="{ 'border-primary bg-light': schedulePreset === 'daily' }"
                                @click="selectPreset('daily')"
                            >
                                <div class="fw-bold">{{ $t("Daily") }}</div>
                                <div class="small text-secondary">{{ $t("Every day at 2:00 AM") }}</div>
                            </div>
                        </div>
                        <div class="col-md-4">
                            <div
                                class="border rounded p-3 text-center cursor-pointer"
                                :class="{ 'border-primary bg-light': schedulePreset === 'weekly' }"
                                @click="selectPreset('weekly')"
                            >
                                <div class="fw-bold">{{ $t("Weekly") }}</div>
                                <div class="small text-secondary">{{ $t("Every Sunday at 2:00 AM") }}</div>
                            </div>
                        </div>
                        <div class="col-md-4">
                            <div
                                class="border rounded p-3 text-center cursor-pointer"
                                :class="{ 'border-primary bg-light': schedulePreset === 'custom' }"
                                @click="selectPreset('custom')"
                            >
                                <div class="fw-bold">{{ $t("Custom Cron") }}</div>
                                <div class="small text-secondary">{{ $t("Advanced cron expression") }}</div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Cron Input -->
                <div class="mb-4">
                    <label class="form-label fw-bold" for="cronExpression">
                        {{ $t("Cron Expression") }}
                    </label>
                    <input
                        id="cronExpression"
                        v-model="scheduleConfig.cron"
                        type="text"
                        class="form-control"
                        :readonly="schedulePreset !== 'custom'"
                        required
                    />
                    <div class="form-text">
                        {{ $t("Standard 5-part cron syntax: minute hour day-of-month month day-of-week") }}
                    </div>
                </div>

                <!-- Container State Mode -->
                <div class="mb-4">
                    <label class="form-label fw-bold">{{ $t("Container Mode During Backup") }}</label>
                    <select v-model="scheduleConfig.containerMode" class="form-select">
                        <option value="none">
                            {{ $t("Live Backup (No downtime - default)") }}
                        </option>
                        <option value="pause">
                            {{ $t("Pause Containers (Freezes memory/processes during archiving)") }}
                        </option>
                        <option value="stop">
                            {{ $t("Stop Containers (Crash-consistent database volume backups)") }}
                        </option>
                    </select>
                </div>

                <!-- Include Dockge Data Toggle -->
                <div class="form-check mb-4">
                    <input
                        id="includeDockgeDataCheck"
                        v-model="scheduleConfig.includeDockgeData"
                        class="form-check-input"
                        type="checkbox"
                    />
                    <label class="form-check-label" for="includeDockgeDataCheck">
                        {{ $t("Include Dockge internal database & configuration (/app/data/dockge.db)") }}
                    </label>
                </div>

                <!-- Retention Pruning Policies -->
                <h5 class="mb-3">{{ $t("PBS Pruning & Retention Policies") }}</h5>
                <p class="text-secondary small">
                    {{ $t("Old snapshots are automatically pruned on Proxmox Backup Server according to these rules.") }}
                </p>

                <div class="row g-3 mb-4">
                    <div class="col-md-3">
                        <label class="form-label" for="keepLast">{{ $t("Keep Last") }}</label>
                        <input
                            id="keepLast"
                            v-model.number="scheduleConfig.keepLast"
                            type="number"
                            min="0"
                            class="form-control"
                        />
                    </div>
                    <div class="col-md-3">
                        <label class="form-label" for="keepDaily">{{ $t("Keep Daily") }}</label>
                        <input
                            id="keepDaily"
                            v-model.number="scheduleConfig.keepDaily"
                            type="number"
                            min="0"
                            class="form-control"
                        />
                    </div>
                    <div class="col-md-3">
                        <label class="form-label" for="keepWeekly">{{ $t("Keep Weekly") }}</label>
                        <input
                            id="keepWeekly"
                            v-model.number="scheduleConfig.keepWeekly"
                            type="number"
                            min="0"
                            class="form-control"
                        />
                    </div>
                    <div class="col-md-3">
                        <label class="form-label" for="keepMonthly">{{ $t("Keep Monthly") }}</label>
                        <input
                            id="keepMonthly"
                            v-model.number="scheduleConfig.keepMonthly"
                            type="number"
                            min="0"
                            class="form-control"
                        />
                    </div>
                </div>

                <div>
                    <button class="btn btn-primary" type="submit" :disabled="savingSchedule">
                        <font-awesome-icon v-if="savingSchedule" icon="spinner" spin class="me-1" />
                        <font-awesome-icon v-else icon="save" class="me-1" />
                        {{ $t("Save Schedule & Retention") }}
                    </button>
                </div>
            </form>
        </div>

        <!-- Modals -->
        <PbsRestoreModal
            :show="showRestoreModal"
            :snapshot="selectedSnapshot"
            @close="showRestoreModal = false"
            @restore-started="onRestoreStarted"
        />

        <PbsConsoleModal
            :show="showConsole"
            :logs="logs"
            :is-operating="status.isOperating"
            :current-operation="status.currentOperation"
            @close="showConsole = false"
            @clear-logs="logs = []"
        />
    </div>
</template>

<script>
import PbsRestoreModal from "../backup/PbsRestoreModal.vue";
import PbsConsoleModal from "../backup/PbsConsoleModal.vue";

export default {
    components: {
        PbsRestoreModal,
        PbsConsoleModal,
    },
    data() {
        return {
            activeTab: "snapshots",
            loadingSnapshots: false,
            savingConfig: false,
            testingConnection: false,
            savingSchedule: false,

            // Modals
            showRestoreModal: false,
            showConsole: false,
            selectedSnapshot: null,

            // Data
            pbsConfig: {
                enabled: false,
                host: "",
                port: 8007,
                datastore: "",
                authId: "",
                secret: "",
                fingerprint: "",
                namespace: "",
                backupId: "dockge",
            },
            scheduleConfig: {
                enabled: false,
                cron: "0 2 * * *",
                containerMode: "none",
                includeDockgeData: true,
                keepLast: 7,
                keepDaily: 7,
                keepWeekly: 4,
                keepMonthly: 12,
            },
            schedulePreset: "daily",
            status: {
                isOperating: false,
                currentOperation: "idle",
                lastBackup: null,
                nextScheduledRun: null,
            },
            snapshots: [],
            snapshotFilter: "",
            logs: [],
        };
    },
    computed: {
        filteredSnapshots() {
            if (!this.snapshotFilter.trim()) {
                return this.snapshots;
            }
            const q = this.snapshotFilter.toLowerCase();
            return this.snapshots.filter((s) => {
                return s.snapshotId.toLowerCase().includes(q) ||
                    (s.backupTimeISO && s.backupTimeISO.toLowerCase().includes(q));
            });
        },
    },
    mounted() {
        this.loadPbsConfig();
        this.loadScheduleConfig();
        this.loadStatus();
        this.loadSnapshots();

        // Socket Event Listeners
        const socket = this.$root.getSocket();
        socket.on("pbsLog", (logEvent) => {
            this.logs.push(logEvent);
        });

        socket.on("pbsBackupFinished", (res) => {
            this.loadStatus();
            this.loadSnapshots();
            if (res.ok) {
                this.$root.toastSuccess(res.message);
            } else {
                this.$root.toastError(res.message);
            }
        });

        socket.on("pbsRestoreFinished", (res) => {
            this.loadStatus();
            if (res.ok) {
                this.$root.toastSuccess(res.message);
            } else {
                this.$root.toastError(res.message);
            }
        });
    },
    methods: {
        loadPbsConfig() {
            this.$root.getSocket().emit("getPbsConfig", (res) => {
                if (res.ok && res.data) {
                    this.pbsConfig = { ...this.pbsConfig, ...res.data };
                }
            });
        },
        loadScheduleConfig() {
            this.$root.getSocket().emit("getPbsSchedule", (res) => {
                if (res.ok && res.data) {
                    this.scheduleConfig = { ...this.scheduleConfig, ...res.data };
                    if (this.scheduleConfig.cron === "0 2 * * *") {
                        this.schedulePreset = "daily";
                    } else if (this.scheduleConfig.cron === "0 2 * * 0") {
                        this.schedulePreset = "weekly";
                    } else {
                        this.schedulePreset = "custom";
                    }
                }
            });
        },
        loadStatus() {
            this.$root.getSocket().emit("getPbsStatus", (res) => {
                if (res.ok && res.data) {
                    this.status = res.data;
                    if (res.data.recentLogs && res.data.recentLogs.length > 0) {
                        this.logs = res.data.recentLogs;
                    }
                }
            });
        },
        loadSnapshots() {
            if (!this.pbsConfig.enabled && !this.pbsConfig.host) {
                return;
            }
            this.loadingSnapshots = true;
            this.$root.getSocket().emit("getPbsSnapshots", (res) => {
                this.loadingSnapshots = false;
                if (res.ok && Array.isArray(res.data)) {
                    this.snapshots = res.data;
                } else {
                    this.snapshots = [];
                }
            });
        },
        savePbsConfig() {
            this.savingConfig = true;
            this.$root.getSocket().emit("savePbsConfig", this.pbsConfig, (res) => {
                this.savingConfig = false;
                if (res.ok) {
                    this.$root.toastSuccess(res.msg);
                    this.loadPbsConfig();
                    this.loadSnapshots();
                } else {
                    this.$root.toastError(res.msg);
                }
            });
        },
        testConnection() {
            this.testingConnection = true;
            this.$root.getSocket().emit("testPbsConnection", this.pbsConfig, (res) => {
                this.testingConnection = false;
                if (res.ok) {
                    this.$root.toastSuccess(res.msg);
                } else {
                    this.$root.toastError(res.msg);
                }
            });
        },
        selectPreset(preset) {
            this.schedulePreset = preset;
            if (preset === "daily") {
                this.scheduleConfig.cron = "0 2 * * *";
            } else if (preset === "weekly") {
                this.scheduleConfig.cron = "0 2 * * 0";
            }
        },
        saveSchedule() {
            this.savingSchedule = true;
            this.$root.getSocket().emit("savePbsSchedule", this.scheduleConfig, (res) => {
                this.savingSchedule = false;
                if (res.ok) {
                    this.$root.toastSuccess(res.msg);
                    this.loadStatus();
                } else {
                    this.$root.toastError(res.msg);
                }
            });
        },
        triggerManualBackup() {
            this.showConsole = true;
            this.$root.getSocket().emit("startPbsBackup", {
                containerMode: this.scheduleConfig.containerMode || "none",
                includeDockgeData: this.scheduleConfig.includeDockgeData !== false,
            }, (res) => {
                if (res.ok) {
                    this.$root.toastSuccess(res.msg);
                    this.loadStatus();
                } else {
                    this.$root.toastError(res.msg);
                }
            });
        },
        openRestoreModal(snapshot) {
            this.selectedSnapshot = snapshot;
            this.showRestoreModal = true;
        },
        onRestoreStarted() {
            this.showConsole = true;
            this.loadStatus();
        },
        deleteSnapshot(snapshot) {
            if (!confirm(`Are you sure you want to delete snapshot ${snapshot.snapshotId}?`)) {
                return;
            }
            this.$root.getSocket().emit("deletePbsSnapshot", snapshot.snapshotId, (res) => {
                if (res.ok) {
                    this.$root.toastSuccess(res.msg);
                    this.loadSnapshots();
                } else {
                    this.$root.toastError(res.msg);
                }
            });
        },
        formatDate(dateStr) {
            if (!dateStr) return "-";
            return new Date(dateStr).toLocaleString();
        },
        formatSize(bytes) {
            if (!bytes || bytes === 0) return "0 B";
            const k = 1024;
            const sizes = ["B", "KB", "MB", "GB", "TB"];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
        },
    },
};
</script>

<style scoped>
.cursor-pointer {
    cursor: pointer;
    transition: all 0.15s ease-in-out;
}
.cursor-pointer:hover {
    background-color: rgba(0, 0, 0, 0.03);
}
</style>

