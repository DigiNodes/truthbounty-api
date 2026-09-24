import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Query,
  Param,
  NotFoundException,
  BadRequestException,
  Header,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { ProfilerService } from './profiler.service';
import { SamplingConfig, SpanCategory } from './interfaces/profiler.interface';

@ApiTags('Performance Profiler')
@Controller('profiler')
export class ProfilerController {
  constructor(private readonly profilerService: ProfilerService) {}

  @Get('summary')
  @ApiOperation({ summary: 'Get summary of profiling service status and high-level metrics' })
  getSummary() {
    return this.profilerService.getSummary();
  }

  @Get('metrics')
  @ApiOperation({ summary: 'Get latency distributions (p50-p99) and resource metrics' })
  @ApiQuery({ name: 'route', required: false })
  @ApiQuery({ name: 'category', required: false })
  getMetrics(
    @Query('route') route?: string,
    @Query('category') category?: SpanCategory,
  ) {
    const latency = this.profilerService.getLatencyDistributions({ route, category });
    return {
      timestamp: new Date().toISOString(),
      latency,
    };
  }

  @Get('traces')
  @ApiOperation({ summary: 'Get recorded traces with optional filtering' })
  @ApiQuery({ name: 'route', required: false })
  @ApiQuery({ name: 'method', required: false })
  @ApiQuery({ name: 'category', required: false })
  @ApiQuery({ name: 'minDurationMs', required: false })
  @ApiQuery({ name: 'hasSlowQueries', required: false })
  @ApiQuery({ name: 'limit', required: false })
  getTraces(
    @Query('route') route?: string,
    @Query('method') method?: string,
    @Query('category') category?: SpanCategory,
    @Query('minDurationMs') minDurationMs?: string,
    @Query('hasSlowQueries') hasSlowQueries?: string,
    @Query('limit') limit?: string,
  ) {
    const traces = this.profilerService.getTraces({
      route,
      method,
      category,
      minDurationMs: minDurationMs ? parseFloat(minDurationMs) : undefined,
      hasSlowQueries: hasSlowQueries === 'true' || hasSlowQueries === '1',
      limit: limit ? parseInt(limit, 10) : 50,
    });

    return {
      count: traces.length,
      traces,
    };
  }

  @Get('traces/:id')
  @ApiOperation({ summary: 'Get detailed execution trace breakdown by ID' })
  getTraceById(@Param('id') id: string) {
    const trace = this.profilerService.getTraceById(id);
    if (!trace) {
      throw new NotFoundException(`Trace with ID '${id}' not found`);
    }
    return trace;
  }

  @Get('traces/:id/flamegraph')
  @ApiOperation({ summary: 'Generate hierarchical flame graph data structure for trace' })
  getFlameGraph(@Param('id') id: string) {
    const flameGraph = this.profilerService.generateFlameGraph(id);
    if (!flameGraph) {
      throw new NotFoundException(`Trace or FlameGraph for ID '${id}' not found`);
    }
    return {
      traceId: id,
      flameGraph,
    };
  }

  @Get('bottlenecks')
  @ApiOperation({ summary: 'Generate bottleneck report for slow queries, endpoints, Redis, RPC & CPU hotspots' })
  getBottleneckReport() {
    return this.profilerService.generateBottleneckReport();
  }

  @Get('snapshots')
  @ApiOperation({ summary: 'List historical performance snapshots' })
  getSnapshots() {
    return {
      count: this.profilerService.getHistoricalSnapshots().length,
      snapshots: this.profilerService.getHistoricalSnapshots(),
    };
  }

  @Post('snapshots')
  @ApiOperation({ summary: 'Take a new historical baseline performance snapshot' })
  takeSnapshot(@Body('name') name: string) {
    if (!name) {
      throw new BadRequestException('Snapshot name is required');
    }
    const snapshot = this.profilerService.takeHistoricalSnapshot(name);
    return {
      message: 'Historical performance snapshot created successfully',
      snapshot,
    };
  }

  @Get('compare')
  @ApiOperation({ summary: 'Compare historical performance between two baseline snapshots' })
  @ApiQuery({ name: 'baselineId', required: true })
  @ApiQuery({ name: 'targetId', required: true })
  compareSnapshots(
    @Query('baselineId') baselineId: string,
    @Query('targetId') targetId: string,
  ) {
    if (!baselineId || !targetId) {
      throw new BadRequestException('Both baselineId and targetId query parameters are required');
    }
    const comparison = this.profilerService.compareHistorical(baselineId, targetId);
    if (!comparison) {
      throw new NotFoundException('One or both specified snapshot IDs were not found');
    }
    return comparison;
  }

  @Get('regressions')
  @ApiOperation({ summary: 'Detect performance regressions between target and baseline snapshots' })
  @ApiQuery({ name: 'baselineId', required: true })
  @ApiQuery({ name: 'targetId', required: true })
  @ApiQuery({ name: 'thresholdPercent', required: false })
  detectRegressions(
    @Query('baselineId') baselineId: string,
    @Query('targetId') targetId: string,
    @Query('thresholdPercent') thresholdPercent?: string,
  ) {
    if (!baselineId || !targetId) {
      throw new BadRequestException('Both baselineId and targetId query parameters are required');
    }
    const threshold = thresholdPercent ? parseFloat(thresholdPercent) : 20;
    return this.profilerService.detectRegressions(baselineId, targetId, threshold);
  }

  @Get('sampling')
  @ApiOperation({ summary: 'Get current profiler sampling strategy and configuration' })
  getSamplingConfig() {
    return this.profilerService.getSamplingConfig();
  }

  @Put('sampling')
  @ApiOperation({ summary: 'Dynamically update profiler sampling configuration' })
  updateSamplingConfig(@Body() config: Partial<SamplingConfig>) {
    const updated = this.profilerService.updateSamplingConfig(config);
    return {
      message: 'Profiler sampling configuration updated successfully',
      config: updated,
    };
  }

  @Get('dashboard')
  @ApiOperation({ summary: 'Get dashboard data representation or HTML UI view' })
  @Header('Content-Type', 'text/html')
  getDashboard() {
    const summary = this.profilerService.getSummary();
    const bottlenecks = this.profilerService.generateBottleneckReport();
    const latency = this.profilerService.getLatencyDistributions();

    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>TruthBounty Backend Profiling Dashboard</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 24px; }
    h1 { color: #38bdf8; margin-bottom: 8px; }
    .subtitle { color: #94a3b8; font-size: 14px; margin-bottom: 24px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .card { background: #1e293b; border-radius: 8px; padding: 16px; border: 1px solid #334155; }
    .card-title { color: #94a3b8; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; }
    .card-value { font-size: 28px; font-weight: bold; color: #f8fafc; margin-top: 8px; }
    .table-container { background: #1e293b; border-radius: 8px; padding: 16px; margin-bottom: 24px; border: 1px solid #334155; }
    table { width: 100%; border-collapse: collapse; text-align: left; }
    th { color: #94a3b8; border-bottom: 1px solid #334155; padding: 8px; font-size: 13px; }
    td { border-bottom: 1px solid #1e293b; padding: 8px; font-size: 14px; }
    .badge { padding: 4px 8px; border-radius: 4px; font-size: 12px; background: #0284c7; color: white; display: inline-block; }
  </style>
</head>
<body>
  <h1>⚡ TruthBounty Profiling Dashboard</h1>
  <div class="subtitle">Real-time Performance Engineering, Flame Graphs & Regressions</div>

  <div class="grid">
    <div class="card">
      <div class="card-title">Total Traces</div>
      <div class="card-value">${summary.metrics.totalTraces}</div>
    </div>
    <div class="card">
      <div class="card-title">Average Latency</div>
      <div class="card-value">${summary.metrics.avgDurationMs} ms</div>
    </div>
    <div class="card">
      <div class="card-title">p95 Latency</div>
      <div class="card-value">${latency.p95} ms</div>
    </div>
    <div class="card">
      <div class="card-title">p99 Latency</div>
      <div class="card-value">${latency.p99} ms</div>
    </div>
    <div class="card">
      <div class="card-title">Sampling Strategy</div>
      <div class="card-value" style="font-size: 18px; color: #38bdf8;">${summary.samplingConfig.strategy} (${summary.samplingConfig.defaultSampleRate * 100}%)</div>
    </div>
  </div>

  <div class="table-container">
    <h2>🐢 Slowest Endpoints</h2>
    <table>
      <thead>
        <tr><th>Method</th><th>Route</th><th>Avg Latency</th><th>p95 Latency</th><th>Requests</th></tr>
      </thead>
      <tbody>
        ${
          bottlenecks.slowEndpoints.length === 0
            ? '<tr><td colspan="5">No endpoints recorded yet</td></tr>'
            : bottlenecks.slowEndpoints
                .map(
                  (e) =>
                    `<tr><td><span class="badge">${e.method}</span></td><td>${e.route}</td><td>${e.avgDurationMs} ms</td><td>${e.p95DurationMs} ms</td><td>${e.count}</td></tr>`,
                )
                .join('')
        }
      </tbody>
    </table>
  </div>

  <div class="table-container">
    <h2>🗄️ Database Query Bottlenecks</h2>
    <table>
      <thead>
        <tr><th>Query</th><th>Entity</th><th>Avg Duration</th><th>Max Duration</th><th>Count</th></tr>
      </thead>
      <tbody>
        ${
          bottlenecks.slowQueries.length === 0
            ? '<tr><td colspan="5">No slow database queries recorded</td></tr>'
            : bottlenecks.slowQueries
                .map(
                  (q) =>
                    `<tr><td><code>${q.query.substring(0, 80)}</code></td><td>${q.entity || 'n/a'}</td><td>${q.avgDurationMs} ms</td><td>${q.maxDurationMs} ms</td><td>${q.executionCount}</td></tr>`,
                )
                .join('')
        }
      </tbody>
    </table>
  </div>
</body>
</html>
    `;
  }
}
