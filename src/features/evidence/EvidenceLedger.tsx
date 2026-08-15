import { useMemo, useState, type KeyboardEvent } from 'react'
import { ChevronDown } from 'lucide-react'
import type { Evidence, Severity } from '../../domain/report'
import type { SelectorSignatureLookup } from '../../domain/selectors'
import { AppDropdown, type AppDropdownOption } from '../../components/AppDropdown'
import {
  SelectorAwareText,
  SelectorCatalogList,
  SelectorInline,
  selectorAwareJson,
  selectorsForDisplay,
} from '../selectors/SelectorDisplay'
import { EVIDENCE_SEVERITY_META, groupEvidenceBySeverity } from './evidenceGrouping'

type StorageLayoutEntry = {
  slot: string
  type?: string
  reads: string[]
  writes: string[]
}

type EvidenceFilter = Severity | 'all'

function SeverityBadge({ severity }: { severity: Severity }) {
  const meta = EVIDENCE_SEVERITY_META[severity]
  return (
    <span
      className={`evidence-severity-badge impact-${severity}`}
      aria-label={`${meta.label} severity`}
      title={`${meta.label} severity`}
    >
      <span aria-hidden="true">{meta.shortLabel}</span>
    </span>
  )
}

function evidenceClassLabel(value: Evidence['evidenceClass']) {
  return value.replaceAll('-', ' ')
}

function storageLayoutFromTechnical(technical: Evidence['technical']): StorageLayoutEntry[] {
  if (!technical || !Array.isArray(technical.slots)) return []
  return technical.slots.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || !('slot' in entry) || typeof entry.slot !== 'string') return []
    const reads = 'reads' in entry && Array.isArray(entry.reads)
      ? entry.reads.filter((value: unknown): value is string => typeof value === 'string')
      : []
    const writes = 'writes' in entry && Array.isArray(entry.writes)
      ? entry.writes.filter((value: unknown): value is string => typeof value === 'string')
      : []
    return [{
      slot: entry.slot,
      type: 'type' in entry && typeof entry.type === 'string' ? entry.type : undefined,
      reads,
      writes,
    }]
  })
}

function EvidenceRow({ finding, selectorSignatures }: { finding: Evidence; selectorSignatures?: SelectorSignatureLookup }) {
  const [open, setOpen] = useState(false)
  const detailId = `evidence-detail-${finding.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`
  const storageLayout = storageLayoutFromTechnical(finding.technical)
  const technicalSelectors = selectorsForDisplay(finding.technical, selectorSignatures).map((entry) => entry.selector)
  const toggle = () => setOpen((value) => !value)

  const handleRowClick = () => {
    // A completed drag-selection should copy normally instead of immediately
    // collapsing the record when the pointer is released.
    const selection = window.getSelection()
    if (selection && !selection.isCollapsed) return
    toggle()
  }

  const handleRowKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    toggle()
  }

  return (
    <article className={`evidence-card impact-${finding.severity}${open ? ' open' : ''}`}>
      <div
        className="evidence-main"
        role="button"
        tabIndex={0}
        onClick={handleRowClick}
        onKeyDown={handleRowKeyDown}
        aria-expanded={open}
        aria-controls={detailId}
        aria-label={`${open ? 'Collapse' : 'Expand'} ${finding.title}`}
      >
        <span className="evidence-row-mark">
          <SeverityBadge severity={finding.severity} />
        </span>
        <span className="evidence-copy">
          <strong><SelectorAwareText lookup={selectorSignatures} subject={finding.subject}>{finding.title}</SelectorAwareText></strong>
          <span><SelectorAwareText lookup={selectorSignatures} subject={finding.subject}>{finding.claim}</SelectorAwareText></span>
        </span>
        <span className="evidence-tags" aria-label={`${evidenceClassLabel(finding.evidenceClass)}, ${finding.confidence} confidence`}>
          <span>{evidenceClassLabel(finding.evidenceClass)}</span>
          <span>{finding.confidence}</span>
        </span>
        <span
          className="evidence-toggle"
          aria-hidden="true"
        >
          <ChevronDown className="evidence-chevron" size={17} aria-hidden="true" />
        </span>
      </div>

      {open && (
        <div className="evidence-detail" id={detailId}>
          <dl className="evidence-facts">
            <div><dt>Subject</dt><dd><code>{finding.subject}</code></dd></div>
            <div><dt>Detector</dt><dd><code>{finding.detectorId}</code><small>v{finding.detectorVersion}</small></dd></div>
            <div><dt>Evidence</dt><dd>{evidenceClassLabel(finding.evidenceClass)}</dd></div>
            <div><dt>Confidence</dt><dd>{finding.confidence}</dd></div>
            <div><dt>Reproducibility</dt><dd>{finding.reproducibility}</dd></div>
            <div><dt>PC</dt><dd>{finding.programCounter ?? 'Contract'}</dd></div>
          </dl>

          {finding.affectedPools.length > 0 && (
            <div className="evidence-block">
              <h4>Affected pools <span>{finding.affectedPools.length}</span></h4>
              <div className="evidence-code-list">{finding.affectedPools.map((pool) => <code key={pool}>{pool}</code>)}</div>
            </div>
          )}

          {finding.callPath?.length && (
            <div className="evidence-block">
              <h4>Call path <span>{finding.callPath.length} contracts</span></h4>
              <ol className="evidence-call-path">{finding.callPath.map((address, pathIndex) => <li key={`${address}-${pathIndex}`}><code>{address}</code></li>)}</ol>
            </div>
          )}

          {storageLayout.length > 0 && (
            <div className="evidence-block">
              <h4>Recovered storage layout <span>{storageLayout.length} slots</span></h4>
              <div className="evidence-table-scroll">
                <table className="evidence-storage-table">
                  <thead><tr><th>Slot</th><th>Type</th><th>Writers</th><th>Readers</th></tr></thead>
                  <tbody>
                    {storageLayout.map((entry) => (
                      <tr key={entry.slot}>
                        <td><code>{entry.slot}</code></td>
                        <td>{entry.type ?? 'Unknown'}</td>
                        <td>{entry.writes.length ? entry.writes.map((item) => <SelectorInline compact key={item} selector={item} lookup={selectorSignatures} subject={finding.subject} />) : 'Not recorded'}</td>
                        <td>{entry.reads.length ? entry.reads.map((item) => <SelectorInline compact key={item} selector={item} lookup={selectorSignatures} subject={finding.subject} />) : 'Not recorded'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {finding.storage?.length && storageLayout.length === 0 && (
            <div className="evidence-block">
              <h4>Storage changes <span>{finding.storage.length}</span></h4>
              <div className="evidence-table-scroll">
                <table className="evidence-storage-table">
                  <thead><tr><th>Slot</th><th>Before</th><th>After</th></tr></thead>
                  <tbody>{finding.storage.map((item) => <tr key={item.slot}><td><code>{item.slot}</code></td><td><code>{item.before ?? 'Not recorded'}</code></td><td><code>{item.after ?? 'Not recorded'}</code></td></tr>)}</tbody>
                </table>
              </div>
            </div>
          )}

          {finding.witness && (
            <div className="evidence-block">
              <h4>Replay witness <span>{finding.witness.expectedOutcome}</span></h4>
              <dl className="evidence-witness">
                <div><dt>From</dt><dd><code>{finding.witness.from}</code></dd></div>
                <div><dt>To</dt><dd><code>{finding.witness.to}</code></dd></div>
                <div><dt>Block</dt><dd>{finding.witness.blockNumber}</dd></div>
                <div><dt>Value</dt><dd>{finding.witness.value}</dd></div>
                <div className="evidence-witness-input"><dt>Input</dt><dd>
                  {finding.witness.input.length >= 10 && <SelectorInline selector={finding.witness.input.slice(0, 10)} lookup={selectorSignatures} subject={finding.witness.to} />}
                  <code>{finding.witness.input}</code>
                </dd></div>
              </dl>
            </div>
          )}

          {technicalSelectors.length > 0 && (
            <div className="evidence-block">
              <h4>Function and error selectors <span>{technicalSelectors.length}</span></h4>
              <SelectorCatalogList selectors={technicalSelectors} lookup={selectorSignatures} subject={finding.subject} />
            </div>
          )}

          {finding.technical && (
            <details className="evidence-raw">
              <summary>Readable technical record</summary>
              <pre>{selectorAwareJson(finding.technical, selectorSignatures)}</pre>
            </details>
          )}
        </div>
      )}
    </article>
  )
}

export function EvidenceLedger({ findings, selectorSignatures }: { findings: Evidence[]; selectorSignatures?: SelectorSignatureLookup }) {
  const [selectedSeverity, setSelectedSeverity] = useState<EvidenceFilter>('all')
  const groups = useMemo(() => groupEvidenceBySeverity(findings), [findings])
  const sortedFindings = useMemo(() => groups.flatMap((group) => group.findings), [groups])
  const availableSeverities = useMemo(() => new Set(groups.map((group) => group.severity)), [groups])
  const effectiveSeverity = selectedSeverity === 'all' || availableSeverities.has(selectedSeverity) ? selectedSeverity : 'all'
  const displayedFindings = effectiveSeverity === 'all'
    ? sortedFindings
    : groups.find((group) => group.severity === effectiveSeverity)?.findings ?? []
  const filterOptions = useMemo<AppDropdownOption<EvidenceFilter>[]>(() => [
    {
      value: 'all',
      label: 'All evidence',
      description: `${findings.length} records · severity order`,
      icon: <span className="evidence-severity-badge evidence-severity-all" aria-hidden="true">A</span>,
    },
    ...groups.map((group) => ({
      value: group.severity,
      label: group.label,
      description: `${group.findings.length} record${group.findings.length === 1 ? '' : 's'}`,
      icon: <SeverityBadge severity={group.severity} />,
    })),
  ], [findings.length, groups])

  if (!findings.length) return <p className="empty-ledger">No reportable bytecode behavior was recovered for this batch.</p>

  return (
    <div className="evidence-ledger">
      <div className="evidence-toolbar">
        <div>
          <strong>{displayedFindings.length}</strong>
          <span>{effectiveSeverity === 'all' ? 'records · highest severity first' : `${EVIDENCE_SEVERITY_META[effectiveSeverity].label} severity records`}</span>
        </div>
        <AppDropdown
          className="evidence-filter"
          ariaLabel="Filter evidence by severity"
          density="compact"
          value={effectiveSeverity}
          options={filterOptions}
          onChange={setSelectedSeverity}
          menuMaxHeight={280}
        />
      </div>
      <div className="evidence-list" aria-live="polite">
        {displayedFindings.map((finding) => <EvidenceRow finding={finding} selectorSignatures={selectorSignatures} key={finding.id} />)}
      </div>
    </div>
  )
}
