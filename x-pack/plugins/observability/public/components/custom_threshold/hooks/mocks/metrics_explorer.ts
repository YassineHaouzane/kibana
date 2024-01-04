/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  ExpressionOptions,
  ExpressionTimestampsRT,
  MetricsExplorerResponse,
  MetricsExplorerSeries,
} from '../../types';

export const options: ExpressionOptions = {
  limit: 3,
  groupBy: 'host.name',
  aggregation: 'avg',
  metrics: [{ aggregation: 'avg', field: 'system.cpu.user.pct' }],
};

export const source = {
  name: 'default',
  description: '',
  metricAlias: 'metricbeat-*',
  inventoryDefaultView: 'host',
  metricsExplorerDefaultView: 'host',
  fields: {
    host: 'host.name',
    container: 'container.id',
    pod: 'kubernetes.pod.uid',
    timestamp: '@timestamp',
    message: ['message'],
    tiebreaker: '@timestamp',
  },
  anomalyThreshold: 20,
};
export const derivedIndexPattern = { title: 'metricbeat-*', fields: [] };

export const mockedTimestamps: ExpressionTimestampsRT = {
  fromTimestamp: 1678376367166,
  toTimestamp: 1678379973620,
  interval: '>=10s',
  timeFieldName: '@timestamp',
};

export const createSeries = (id: string): MetricsExplorerSeries => ({
  id,
  columns: [
    { name: 'timestamp', type: 'date' },
    { name: 'metric_0', type: 'number' },
    { name: 'groupBy', type: 'string' },
  ],
  rows: [
    { timestamp: 1, metric_0: 0.5, groupBy: id },
    { timestamp: 2, metric_0: 0.5, groupBy: id },
    { timestamp: 3, metric_0: 0.5, groupBy: id },
  ],
});

export const resp: MetricsExplorerResponse = {
  pageInfo: { total: 10, afterKey: 'host-04' },
  series: [createSeries('host-01'), createSeries('host-02'), createSeries('host-03')],
};
