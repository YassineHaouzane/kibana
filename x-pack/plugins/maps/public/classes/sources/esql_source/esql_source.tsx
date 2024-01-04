/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import React from 'react';
import { i18n } from '@kbn/i18n';
import { lastValueFrom } from 'rxjs';
import { tap } from 'rxjs/operators';
import { v4 as uuidv4 } from 'uuid';
import { Adapters } from '@kbn/inspector-plugin/common/adapters';
import { buildEsQuery, getIndexPatternFromESQLQuery, getLimitFromESQLQuery } from '@kbn/es-query';
import type { BoolQuery, Filter, Query } from '@kbn/es-query';
import type { ESQLSearchReponse } from '@kbn/es-types';
import { getEsQueryConfig } from '@kbn/data-service/src/es_query';
import { getTime } from '@kbn/data-plugin/public';
import { FIELD_ORIGIN, SOURCE_TYPES, VECTOR_SHAPE_TYPE } from '../../../../common/constants';
import type {
  ESQLSourceDescriptor,
  VectorSourceRequestMeta,
} from '../../../../common/descriptor_types';
import { createExtentFilter } from '../../../../common/elasticsearch_util';
import { DataRequest } from '../../util/data_request';
import { isValidStringConfig } from '../../util/valid_string_config';
import type { SourceEditorArgs } from '../source';
import { AbstractVectorSource, getLayerFeaturesRequestName } from '../vector_source';
import type { IVectorSource, GeoJsonWithMeta, SourceStatus } from '../vector_source';
import type { IField } from '../../fields/field';
import { InlineField } from '../../fields/inline_field';
import { getData, getUiSettings } from '../../../kibana_services';
import { convertToGeoJson } from './convert_to_geojson';
import { getFieldType, getGeometryColumnIndex } from './esql_utils';
import { UpdateSourceEditor } from './update_source_editor';

type ESQLSourceSyncMeta = Pick<
  ESQLSourceDescriptor,
  'columns' | 'dateField' | 'esql' | 'narrowByMapBounds'
>;

export const sourceTitle = i18n.translate('xpack.maps.source.esqlSearchTitle', {
  defaultMessage: 'ES|QL',
});

export class ESQLSource extends AbstractVectorSource implements IVectorSource {
  readonly _descriptor: ESQLSourceDescriptor;

  static createDescriptor(descriptor: Partial<ESQLSourceDescriptor>): ESQLSourceDescriptor {
    if (!isValidStringConfig(descriptor.esql)) {
      throw new Error('Cannot create ESQLSourceDescriptor when esql is not provided');
    }
    return {
      ...descriptor,
      id: isValidStringConfig(descriptor.id) ? descriptor.id! : uuidv4(),
      type: SOURCE_TYPES.ESQL,
      esql: descriptor.esql!,
      columns: descriptor.columns ? descriptor.columns : [],
      narrowByGlobalSearch:
        typeof descriptor.narrowByGlobalSearch !== 'undefined'
          ? descriptor.narrowByGlobalSearch
          : true,
      narrowByMapBounds:
        typeof descriptor.narrowByMapBounds !== 'undefined' ? descriptor.narrowByMapBounds : true,
      applyForceRefresh:
        typeof descriptor.applyForceRefresh !== 'undefined' ? descriptor.applyForceRefresh : true,
    };
  }

  constructor(descriptor: ESQLSourceDescriptor) {
    super(ESQLSource.createDescriptor(descriptor));
    this._descriptor = descriptor;
  }

  private _getRequestId(): string {
    return this._descriptor.id;
  }

  async getDisplayName() {
    const pattern: string = getIndexPatternFromESQLQuery(this._descriptor.esql);
    return pattern ? pattern : 'ES|QL';
  }

  async supportsFitToBounds(): Promise<boolean> {
    return false;
  }

  getInspectorRequestIds() {
    return [this._getRequestId()];
  }

  isQueryAware() {
    return true;
  }

  getApplyGlobalQuery() {
    return this._descriptor.narrowByGlobalSearch;
  }

  async isTimeAware() {
    return !!this._descriptor.dateField;
  }

  getApplyGlobalTime() {
    return !!this._descriptor.dateField;
  }

  getApplyForceRefresh() {
    return this._descriptor.applyForceRefresh;
  }

  isFilterByMapBounds() {
    return this._descriptor.narrowByMapBounds;
  }

  async getSupportedShapeTypes() {
    return [VECTOR_SHAPE_TYPE.POINT];
  }

  supportsJoins() {
    return false; // Joins will be part of ESQL statement and not client side join
  }

  async getGeoJsonWithMeta(
    layerName: string,
    requestMeta: VectorSourceRequestMeta,
    registerCancelCallback: (callback: () => void) => void,
    isRequestStillActive: () => boolean,
    inspectorAdapters: Adapters
  ): Promise<GeoJsonWithMeta> {
    const limit = getLimitFromESQLQuery(this._descriptor.esql);
    const params: { query: string; filter?: { bool: BoolQuery } } = {
      query: this._descriptor.esql,
    };

    const query: Query[] = [];
    const filters: Filter[] = [];
    if (this._descriptor.narrowByGlobalSearch) {
      if (requestMeta.query) {
        query.push(requestMeta.query);
      }
      if (requestMeta.embeddableSearchContext?.query) {
        query.push(requestMeta.embeddableSearchContext.query);
      }
      filters.push(...requestMeta.filters);
      if (requestMeta.embeddableSearchContext) {
        filters.push(...requestMeta.embeddableSearchContext.filters);
      }
    }

    if (this._descriptor.narrowByMapBounds && requestMeta.buffer) {
      const geoField =
        this._descriptor.columns[getGeometryColumnIndex(this._descriptor.columns)]?.name;
      if (geoField) {
        const extentFilter = createExtentFilter(requestMeta.buffer, [geoField]);
        filters.push(extentFilter);
      }
    }

    if (requestMeta.applyGlobalTime) {
      const timeRange = requestMeta.timeslice
        ? {
            from: new Date(requestMeta.timeslice.from).toISOString(),
            to: new Date(requestMeta.timeslice.to).toISOString(),
            mode: 'absolute' as 'absolute',
          }
        : requestMeta.timeFilters;
      const timeFilter = getTime(undefined, timeRange, {
        fieldName: this._descriptor.dateField,
      });
      if (timeFilter) {
        filters.push(timeFilter);
      }
    }

    params.filter = buildEsQuery(undefined, query, filters, getEsQueryConfig(getUiSettings()));

    const requestResponder = inspectorAdapters.requests!.start(
      getLayerFeaturesRequestName(layerName),
      {
        id: this._getRequestId(),
      }
    );
    requestResponder.json(params);

    const { rawResponse, requestParams } = await lastValueFrom(
      getData()
        .search.search(
          { params },
          {
            strategy: 'esql',
          }
        )
        .pipe(
          tap({
            error(error) {
              requestResponder.error({
                json: 'attributes' in error ? error.attributes : { message: error.message },
              });
            },
          })
        )
    );

    requestResponder.ok({ json: rawResponse, requestParams });

    const esqlSearchResponse = rawResponse as unknown as ESQLSearchReponse;
    const resultsCount = esqlSearchResponse.values.length;
    return {
      data: convertToGeoJson(esqlSearchResponse),
      meta: {
        resultsCount,
        areResultsTrimmed: resultsCount >= limit,
      },
    };
  }

  getSourceStatus(sourceDataRequest?: DataRequest): SourceStatus {
    const meta = sourceDataRequest ? sourceDataRequest.getMeta() : null;
    if (!meta) {
      // no tooltip content needed when there is no feature collection or meta
      return {
        tooltipContent: null,
        areResultsTrimmed: false,
      };
    }

    if (meta.areResultsTrimmed) {
      return {
        tooltipContent: i18n.translate('xpack.maps.esqlSearch.resultsTrimmedMsg', {
          defaultMessage: `Results limited to first {count} rows.`,
          values: { count: meta.resultsCount?.toLocaleString() },
        }),
        areResultsTrimmed: true,
      };
    }

    return {
      tooltipContent: i18n.translate('xpack.maps.esqlSearch.rowCountMsg', {
        defaultMessage: `Found {count} rows.`,
        values: { count: meta.resultsCount?.toLocaleString() },
      }),
      areResultsTrimmed: false,
    };
  }

  getFieldByName(fieldName: string): IField | null {
    const column = this._descriptor.columns.find(({ name }) => {
      return name === fieldName;
    });
    const fieldType = column ? getFieldType(column) : undefined;
    return column && fieldType
      ? new InlineField({
          fieldName: column.name,
          source: this,
          origin: FIELD_ORIGIN.SOURCE,
          dataType: fieldType,
        })
      : null;
  }

  async getFields() {
    const fields: IField[] = [];
    this._descriptor.columns.forEach((column) => {
      const fieldType = getFieldType(column);
      if (fieldType) {
        fields.push(
          new InlineField({
            fieldName: column.name,
            source: this,
            origin: FIELD_ORIGIN.SOURCE,
            dataType: fieldType,
          })
        );
      }
    });
    return fields;
  }

  renderSourceSettingsEditor({ onChange }: SourceEditorArgs) {
    return <UpdateSourceEditor onChange={onChange} sourceDescriptor={this._descriptor} />;
  }

  getSyncMeta(): ESQLSourceSyncMeta {
    return {
      columns: this._descriptor.columns,
      dateField: this._descriptor.dateField,
      esql: this._descriptor.esql,
      narrowByMapBounds: this._descriptor.narrowByMapBounds,
    };
  }
}
