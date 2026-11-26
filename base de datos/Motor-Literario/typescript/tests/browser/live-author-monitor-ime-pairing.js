/** Correlates beforeinput/input metadata without retaining exportable text. */
export class LiveAuthorMonitorImePairing {
  #nextPairId = 0;
  #pending;
  #disposed = false;
  #counters = {
    pairedInputCount: 0,
    pairedWithoutInputTypeCount: 0,
    unmatchedBeforeInputCount: 0,
    interruptedBeforeInputCount: 0,
    orphanInputCount: 0,
    inputTypeMismatchCount: 0,
    defaultPreventedBeforeInputCount: 0,
    inputDataMatchCount: 0,
    inputDataMismatchCount: 0,
    inputDataOneSidedCount: 0,
    inputDataUnavailableCount: 0
  };

  recordBeforeInput(entry, event) {
    if (this.#disposed) return;
    if (this.#pending) {
      this.#counters.unmatchedBeforeInputCount += 1;
      this.#pending.entry.pairStatus = "superseded-by-next-beforeinput";
      this.#pending.inputData = null;
      this.#pending = undefined;
    }

    const pairId = ++this.#nextPairId;
    entry.pairId = pairId;
    if (entry.defaultPrevented === true) {
      entry.pairStatus = "default-prevented";
      entry.dataComparison = "not-applicable";
      this.#counters.defaultPreventedBeforeInputCount += 1;
      return;
    }

    this.#pending = {
      pairId,
      inputType: entry.inputType,
      inputData: typeof event.data === "string" ? event.data : null,
      entry
    };
    entry.pairStatus = "awaiting-input";
  }

  recordInput(entry, event) {
    if (this.#disposed) return;
    if (!this.#pending) {
      this.#counters.orphanInputCount += 1;
      entry.pairStatus = "orphan-input";
      return;
    }

    const pending = this.#pending;
    entry.pairId = pending.pairId;
    const hasCurrentInputType = typeof entry.inputType === "string" && entry.inputType.length > 0;
    const hasPreviousInputType = typeof pending.inputType === "string" && pending.inputType.length > 0;
    if (hasCurrentInputType && hasPreviousInputType && entry.inputType !== pending.inputType) {
      entry.pairStatus = "inputtype-mismatch";
      pending.entry.pairStatus = "inputtype-mismatch";
      this.#counters.inputTypeMismatchCount += 1;
    } else {
      this.#counters.pairedInputCount += 1;
      if (!hasCurrentInputType) this.#counters.pairedWithoutInputTypeCount += 1;
      entry.pairStatus = hasCurrentInputType ? "paired" : "paired-inputtype-unavailable";
      pending.entry.pairStatus = entry.pairStatus;
    }

    // Compare exact values only transiently; entries and summaries retain no text.
    const inputData = typeof event.data === "string" ? event.data : null;
    if (pending.inputData !== null && inputData !== null) {
      const matches = pending.inputData === inputData;
      entry.dataComparison = matches ? "match" : "mismatch";
      pending.entry.dataComparison = entry.dataComparison;
      if (matches) this.#counters.inputDataMatchCount += 1;
      else this.#counters.inputDataMismatchCount += 1;
    } else if (pending.inputData !== null || inputData !== null) {
      entry.dataComparison = "one-sided";
      pending.entry.dataComparison = "one-sided";
      this.#counters.inputDataOneSidedCount += 1;
    } else {
      entry.dataComparison = "unavailable";
      pending.entry.dataComparison = "unavailable";
      this.#counters.inputDataUnavailableCount += 1;
    }

    pending.inputData = null;
    this.#pending = undefined;
  }

  interrupt(reason = "monitor-error-before-input") {
    if (!this.#pending) return;
    this.#counters.interruptedBeforeInputCount += 1;
    this.#pending.entry.pairStatus = reason;
    this.#pending.inputData = null;
    this.#pending = undefined;
  }

  snapshot() {
    return {
      ...this.#counters,
      pendingBeforeInputCount: this.#pending ? 1 : 0,
      pendingBeforeInputPairId: this.#pending?.pairId ?? null
    };
  }

  dispose() {
    if (this.#disposed) return;
    this.interrupt("page-disposed-before-input");
    this.#disposed = true;
  }
}
