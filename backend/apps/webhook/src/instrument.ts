// Must be the first import in main.ts so OpenTelemetry can patch libraries before they load.
import { startTracing } from '@app/common/tracing';

startTracing('webhook');
