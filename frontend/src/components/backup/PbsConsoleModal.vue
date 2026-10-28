<template>
    <div v-if="show" class="modal fade show d-block" tabindex="-1" style="background-color: rgba(0,0,0,0.6);">
        <div class="modal-dialog modal-xl modal-dialog-scrollable">
            <div class="modal-content">
                <div class="modal-header bg-dark text-white">
                    <h5 class="modal-title">
                        <font-awesome-icon icon="terminal" class="me-2 text-info" />
                        {{ $t("PBS Operation Console") }}
                        <span v-if="isOperating" class="badge bg-warning ms-2">
                            <font-awesome-icon icon="spinner" spin class="me-1" />
                            {{ currentOperation }}
                        </span>
                        <span v-else class="badge bg-secondary ms-2">{{ $t("Idle") }}</span>
                    </h5>
                    <button type="button" class="btn-close btn-close-white" @click="$emit('close')"></button>
                </div>

                <div ref="terminalBody" class="modal-body terminal-window bg-black text-light p-3">
                    <div v-if="logs.length === 0" class="text-secondary fst-italic">
                        {{ $t("No active or recent PBS logs available.") }}
                    </div>
                    <div
                        v-for="(logItem, index) in logs"
                        :key="index"
                        :class="getLogClass(logItem.type)"
                        class="terminal-line"
                    >
                        <span class="text-secondary timestamp me-2">[{{ formatTime(logItem.timestamp) }}]</span>
                        <span>{{ logItem.text }}</span>
                    </div>
                </div>

                <div class="modal-footer bg-dark border-secondary d-flex justify-content-between">
                    <div>
                        <button class="btn btn-sm btn-outline-light me-2" @click="clearLogs">
                            <font-awesome-icon icon="trash" class="me-1" /> {{ $t("Clear") }}
                        </button>
                    </div>
                    <button type="button" class="btn btn-secondary" @click="$emit('close')">
                        {{ $t("Close") }}
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
        logs: {
            type: Array,
            default: () => [],
        },
        isOperating: {
            type: Boolean,
            default: false,
        },
        currentOperation: {
            type: String,
            default: "idle",
        },
    },
    emits: [ "close", "clear-logs" ],
    watch: {
        logs: {
            handler() {
                this.$nextTick(() => {
                    this.scrollToBottom();
                });
            },
            deep: true,
        },
        show(val) {
            if (val) {
                this.$nextTick(() => {
                    this.scrollToBottom();
                });
            }
        },
    },
    methods: {
        formatTime(timestamp) {
            if (!timestamp) {
                return "";
            }
            const d = new Date(timestamp);
            return d.toLocaleTimeString();
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
        scrollToBottom() {
            const el = this.$refs.terminalBody;
            if (el) {
                el.scrollTop = el.scrollHeight;
            }
        },
        clearLogs() {
            this.$emit("clear-logs");
        },
    },
};
</script>

<style scoped>
.terminal-window {
    font-family: "JetBrains Mono", Consolas, "Courier New", monospace;
    font-size: 13px;
    line-height: 1.4;
    min-height: 400px;
    max-height: 60vh;
    white-space: pre-wrap;
    word-break: break-all;
    border-radius: 4px;
}

.terminal-line {
    margin-bottom: 2px;
}

.timestamp {
    font-size: 11px;
    user-select: none;
}
</style>

