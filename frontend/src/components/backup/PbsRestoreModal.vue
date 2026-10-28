<template>
    <div v-if="show" class="modal fade show d-block" tabindex="-1" style="background-color: rgba(0,0,0,0.5);">
        <div class="modal-dialog modal-lg">
            <div class="modal-content">
                <div class="modal-header">
                    <h5 class="modal-title">
                        <font-awesome-icon icon="cloud-arrow-down" class="me-2 text-primary" />
                        {{ $t("Restore Snapshot") }}
                    </h5>
                    <button type="button" class="btn-close" :disabled="loading" @click="close"></button>
                </div>
                <div class="modal-body">
                    <!-- Snapshot Info Alert -->
                    <div class="alert alert-secondary d-flex justify-content-between align-items-center mb-4">
                        <div>
                            <strong>{{ $t("Snapshot") }}:</strong>
                            <code class="ms-2">{{ snapshot?.snapshotId }}</code>
                        </div>
                        <span class="badge bg-secondary">{{ snapshot?.backupTimeISO }}</span>
                    </div>

                    <!-- Warning Alert -->
                    <div class="alert alert-warning">
                        <font-awesome-icon icon="exclamation-circle" class="me-2" />
                        {{ $t("Restoring files will overwrite data in your stacks directory. Please proceed with caution.") }}
                    </div>

                    <!-- Restore Scope Selection -->
                    <div class="mb-4">
                        <label class="form-label fw-bold">{{ $t("Restore Scope") }}</label>
                        <div class="form-check mb-2">
                            <input
                                id="restoreModeSingle"
                                v-model="restoreMode"
                                class="form-check-input"
                                type="radio"
                                value="single"
                            />
                            <label class="form-check-label" for="restoreModeSingle">
                                <strong>{{ $t("Single Stack") }}</strong> ({{ $t("Recommended: only restores a specific stack folder") }})
                            </label>
                        </div>
                        <div class="form-check">
                            <input
                                id="restoreModeFull"
                                v-model="restoreMode"
                                class="form-check-input"
                                type="radio"
                                value="full"
                            />
                            <label class="form-check-label" for="restoreModeFull">
                                <strong>{{ $t("Full Restore") }}</strong> ({{ $t("Extracts the entire stacks archive into your stacks directory") }})
                            </label>
                        </div>
                    </div>

                    <!-- Single Stack Name Input -->
                    <div v-if="restoreMode === 'single'" class="mb-4 ps-4 border-start border-3 border-primary">
                        <label for="targetStackName" class="form-label fw-bold">
                            {{ $t("Target Stack Name") }}
                        </label>
                        <input
                            id="targetStackName"
                            v-model="stackName"
                            type="text"
                            class="form-control"
                            :placeholder="$t('e.g. nginx-proxy, nextcloud')"
                            required
                        />
                        <div class="form-text">
                            {{ $t("Enter the name of the stack folder to extract from this snapshot.") }}
                        </div>
                    </div>

                    <!-- Pre-restore backup safety checkbox -->
                    <div class="form-check mb-3">
                        <input
                            id="createPreRestoreBackup"
                            v-model="createPreRestoreBackup"
                            class="form-check-input"
                            type="checkbox"
                        />
                        <label class="form-check-label" for="createPreRestoreBackup">
                            {{ $t("Create safety backup copy (.bak) of existing stack before overwriting") }}
                        </label>
                    </div>

                    <!-- Auto-start after restore -->
                    <div class="form-check mb-4">
                        <input
                            id="startAfterRestore"
                            v-model="startAfterRestore"
                            class="form-check-input"
                            type="checkbox"
                        />
                        <label class="form-check-label" for="startAfterRestore">
                            {{ $t("Deploy / start containers after restore (docker compose up -d)") }}
                        </label>
                    </div>

                    <!-- Confirmation Checkbox -->
                    <div class="form-check p-3 border border-danger-subtle confirm-box">
                        <input
                            id="confirmRestore"
                            v-model="confirmed"
                            class="form-check-input"
                            type="checkbox"
                        />
                        <label class="form-check-label text-danger fw-bold" for="confirmRestore">
                            {{ $t("I understand this restore operation will modify files and I want to proceed.") }}
                        </label>
                    </div>
                </div>

                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" :disabled="loading" @click="close">
                        {{ $t("Cancel") }}
                    </button>
                    <button
                        type="button"
                        class="btn btn-danger"
                        :disabled="!confirmed || (restoreMode === 'single' && !stackName.trim()) || loading"
                        @click="executeRestore"
                    >
                        <font-awesome-icon v-if="loading" icon="spinner" spin class="me-1" />
                        <font-awesome-icon v-else icon="undo" class="me-1" />
                        {{ $t("Start Restore") }}
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>

<script>
export default {
    props: {
        show: {
            type: Boolean,
            default: false,
        },
        snapshot: {
            type: Object,
            default: null,
        },
    },
    emits: ["close", "restore-started"],
    data() {
        return {
            loading: false,
            restoreMode: "single",
            stackName: "",
            createPreRestoreBackup: true,
            startAfterRestore: false,
            confirmed: false,
        };
    },
    watch: {
        show(val) {
            if (val) {
                this.confirmed = false;
                this.loading = false;
            }
        },
    },
    methods: {
        close() {
            if (!this.loading) {
                this.$emit("close");
            }
        },
        executeRestore() {
            if (!this.confirmed) {
                return;
            }

            this.loading = true;
            const options = {
                snapshot: this.snapshot.snapshotId,
                archiveName: "stacks.pxar",
                stackName: this.restoreMode === "single" ? this.stackName.trim() : undefined,
                createPreRestoreBackup: this.createPreRestoreBackup,
                startAfterRestore: this.startAfterRestore,
            };

            this.$root.getSocket().emit("startPbsRestore", options, (res) => {
                this.loading = false;
                if (res.ok) {
                    this.$root.toastSuccess(res.msg || "Restore started successfully.");
                    this.$emit("restore-started");
                    this.$emit("close");
                } else {
                    this.$root.toastError(res.msg || "Failed to start restore.");
                }
            });
        },
    },
};
</script>

<style scoped>
.modal-content {
    border-radius: 12px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
}
.confirm-box {
    border-radius: 10px;
}
</style>

