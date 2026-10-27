import { Chip, Table } from "@heroui/react";
import type { CandidateReport } from "optiq-image";
import { formatBytes, formatMs } from "../format";

export function CandidatesTable({ candidates, chosen }: { candidates: CandidateReport[]; chosen?: string }) {
  return (
    <Table>
      <Table.ScrollContainer>
        <Table.Content aria-label="Candidates tried">
          <Table.Header>
            <Table.Column isRowHeader>Codec</Table.Column>
            <Table.Column>Settings</Table.Column>
            <Table.Column>Size</Table.Column>
            <Table.Column>Quality</Table.Column>
            <Table.Column>Time</Table.Column>
            <Table.Column>Result</Table.Column>
          </Table.Header>
          <Table.Body>
            {candidates.map((c, i) => {
              const settings = Object.entries(c.settings)
                .map(([k, v]) => `${k}=${v}`)
                .join(" ");
              const isChosen = !c.proxy && `${c.codec}|${settings}|${c.bytes}` === chosen;
              return (
                <Table.Row key={i} id={String(i)}>
                  <Table.Cell>
                    <span className="font-medium">{c.codec}</span>
                    {c.proxy && <span className="ml-1 text-xs text-muted">(tile search)</span>}
                  </Table.Cell>
                  <Table.Cell className="font-mono text-xs">{settings || "–"}</Table.Cell>
                  <Table.Cell className="tabular-nums">{formatBytes(c.bytes)}</Table.Cell>
                  <Table.Cell className="tabular-nums">{c.qualityMetric === "exact" && c.passed ? "exact" : c.quality?.toFixed(4) ?? "–"}</Table.Cell>
                  <Table.Cell className="tabular-nums">{formatMs(c.durationMs)}</Table.Cell>
                  <Table.Cell>
                    {isChosen ? (
                      <Chip size="sm" color="accent">chosen</Chip>
                    ) : c.passed ? (
                      <Chip size="sm" color="success" variant="soft">passed</Chip>
                    ) : (
                      <Chip size="sm" color="danger" variant="soft">below threshold</Chip>
                    )}
                  </Table.Cell>
                </Table.Row>
              );
            })}
          </Table.Body>
        </Table.Content>
      </Table.ScrollContainer>
    </Table>
  );
}
