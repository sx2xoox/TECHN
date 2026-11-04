import { markSensitive, type CollectionSchema, type FieldSchema, type FieldType, type SystemSchema } from '@isomorph/core';

/**
 * 컴파일러 벤치마크용 서로 다른 도메인의 스키마 12종.
 * "사람 개입 없이 렌즈 법칙을 통과하는 비율" KPI 를 측정한다.
 */

type F = [name: string, type: FieldType, extra?: Partial<FieldSchema>];
const ref = (collection: string, enforced = true): Partial<FieldSchema> => ({ ref: { collection, field: 'id' }, refEnforced: enforced });
const en = (...values: string[]): Partial<FieldSchema> => ({ enumValues: values });
const st = (min: number, max: number): Partial<FieldSchema> => ({ stats: { min, max } });

function col(name: string, fields: F[], pkType: FieldType = 'integer'): CollectionSchema {
  return {
    name,
    primaryKey: 'id',
    fields: [{ name: 'id', type: pkType, nullable: false }, ...fields.map(([n, t, x]) => ({ name: n, type: t, nullable: false, ...x }))],
  };
}

function sys(system: string, source: SystemSchema['source'], collections: CollectionSchema[]): SystemSchema {
  return markSensitive({ system, source, collections, constraints: [] });
}

export const BENCH_SCHEMAS: SystemSchema[] = [
  sys('shop', 'postgres', [
    col('customers', [['name', 'string'], ['email', 'string'], ['tier', 'string', en('bronze', 'silver', 'gold')], ['created_at', 'timestamp']]),
    col('products', [['name', 'string'], ['price', 'integer', st(500, 30000)], ['stock', 'integer', st(0, 40)], ['active', 'boolean']]),
    col('orders', [['customer_id', 'integer', ref('customers')], ['product_id', 'integer', ref('products', false)], ['quantity', 'integer', st(1, 3)], ['status', 'string', en('pending', 'paid', 'failed', 'rejected', 'cancelled')], ['created_at', 'timestamp'], ['updated_at', 'timestamp']]),
    { ...col('shop_stats', [['requests_per_min', 'integer', st(0, 400)], ['avg_latency_ms', 'number', st(20, 900)], ['error_count', 'integer', st(0, 9)], ['updated_at', 'timestamp']]), rowCountHint: 1 },
  ]),
  sys('blog', 'postgres', [
    col('users', [['username', 'string'], ['email', 'string'], ['password_hash', 'string'], ['verified', 'boolean'], ['followers_count', 'integer', st(0, 5000)]]),
    col('posts', [['author_id', 'integer', ref('users')], ['title', 'string'], ['status', 'string', en('draft', 'published', 'archived')], ['views', 'integer', st(0, 90000)], ['created_at', 'timestamp']]),
    col('comments', [['post_id', 'integer', ref('posts')], ['user_id', 'integer', ref('users')], ['body', 'string'], ['created_at', 'timestamp']]),
  ]),
  sys('docker', 'docker', [
    col('containers', [['name', 'string'], ['image', 'string'], ['state', 'string', en('created', 'running', 'paused', 'restarting', 'exited', 'dead')], ['status', 'string'], ['cpu_percent', 'number', st(0, 180)], ['mem_mb', 'number', st(10, 900)], ['restart_count', 'integer', st(0, 6)]], 'string'),
  ]),
  sys('kubernetes', 'http', [
    col('nodes', [['name', 'string'], ['ready', 'boolean'], ['cpu_capacity', 'integer', st(2, 64)]]),
    col('pods', [['node_id', 'integer', ref('nodes', false)], ['name', 'string'], ['namespace', 'string'], ['phase', 'string', en('Pending', 'Running', 'Succeeded', 'Failed', 'Unknown')], ['restarts', 'integer', st(0, 30)], ['cpu_millicores', 'integer', st(0, 4000)], ['started_at', 'timestamp']]),
  ]),
  sys('hospital', 'postgres', [
    col('wards', [['name', 'string'], ['beds_total', 'integer', st(10, 40)], ['beds_available', 'integer', st(0, 20)]]),
    col('doctors', [['name', 'string'], ['specialty', 'string', en('surgery', 'pediatrics', 'cardiology', 'er')], ['on_call', 'boolean']]),
    col('patients', [['name', 'string'], ['phone', 'string'], ['ward_id', 'integer', ref('wards')], ['condition', 'string', en('stable', 'serious', 'critical', 'discharged')], ['admitted_at', 'timestamp']]),
    col('appointments', [['patient_id', 'integer', ref('patients')], ['doctor_id', 'integer', ref('doctors')], ['status', 'string', en('scheduled', 'completed', 'cancelled', 'no_show')], ['scheduled_at', 'timestamp']]),
  ]),
  sys('library', 'postgres', [
    col('books', [['title', 'string'], ['author', 'string'], ['copies_available', 'integer', st(0, 8)], ['copies_total', 'integer', st(1, 10)]]),
    col('members', [['name', 'string'], ['email', 'string'], ['banned', 'boolean']]),
    col('loans', [['book_id', 'integer', ref('books')], ['member_id', 'integer', ref('members')], ['returned', 'boolean'], ['due_at', 'timestamp'], ['created_at', 'timestamp']]),
  ]),
  sys('bank', 'postgres', [
    col('accounts', [['owner_name', 'string'], ['balance', 'number', st(0, 1_000_000)], ['frozen', 'boolean'], ['type', 'string', en('checking', 'savings', 'business')]]),
    col('transfers', [['from_account_id', 'integer', ref('accounts')], ['to_account_id', 'integer', ref('accounts')], ['amount', 'number', st(1, 50000)], ['status', 'string', en('pending', 'completed', 'failed', 'reversed')], ['created_at', 'timestamp']]),
  ]),
  sys('school', 'postgres', [
    col('courses', [['title', 'string'], ['capacity', 'integer', st(10, 60)], ['enrolled', 'integer', st(0, 60)]]),
    col('students', [['name', 'string'], ['grade_level', 'integer', st(1, 12)], ['birth_date', 'timestamp']]),
    col('enrollments', [['student_id', 'integer', ref('students')], ['course_id', 'integer', ref('courses')], ['status', 'string', en('enrolled', 'waitlisted', 'dropped')], ['created_at', 'timestamp']]),
  ]),
  sys('logistics', 'http', [
    col('warehouses', [['name', 'string'], ['city', 'string'], ['capacity', 'integer', st(100, 5000)], ['used', 'integer', st(0, 5000)]]),
    col('trucks', [['plate', 'string'], ['warehouse_id', 'integer', ref('warehouses', false)], ['available', 'boolean'], ['fuel_level', 'number', st(0, 100)]]),
    col('shipments', [['warehouse_id', 'integer', ref('warehouses', false)], ['destination', 'string'], ['status', 'string', en('created', 'in_transit', 'delivered', 'lost')], ['weight_kg', 'number', st(1, 900)], ['created_at', 'timestamp'], ['updated_at', 'timestamp']]),
  ]),
  sys('iot', 'http', [
    col('sensors', [['name', 'string'], ['location', 'string'], ['online', 'boolean'], ['battery_pct', 'number', st(0, 100)], ['temperature', 'number', st(-10, 45)]]),
    col('readings', [['sensor_id', 'integer', ref('sensors', false)], ['value', 'number', st(-10, 45)], ['recorded_at', 'timestamp']]),
    col('alerts', [['sensor_id', 'integer', ref('sensors', false)], ['severity', 'string', en('low', 'medium', 'high', 'critical')], ['message', 'string'], ['acknowledged', 'boolean'], ['created_at', 'timestamp']]),
  ]),
  sys('social', 'postgres', [
    col('users', [['username', 'string'], ['followers_count', 'integer', st(0, 100000)], ['verified', 'boolean'], ['banned', 'boolean']]),
    col('messages', [['sender_id', 'integer', ref('users')], ['receiver_id', 'integer', ref('users')], ['read', 'boolean'], ['created_at', 'timestamp']]),
  ]),
  sys('api-gateway', 'http', [
    col('services', [['name', 'string'], ['rps', 'number', st(0, 3000)], ['p95_latency_ms', 'number', st(5, 2000)], ['error_rate', 'number', st(0, 0.2)], ['healthy', 'boolean']]),
    { ...col('gateway_stats', [['total_requests', 'integer', st(0, 1e7)], ['active_connections', 'integer', st(0, 9000)], ['errors_last_min', 'integer', st(0, 50)]]), rowCountHint: 1 },
  ]),
];
