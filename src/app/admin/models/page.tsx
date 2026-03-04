import { createServiceClient } from '@/lib/supabase/server';
import { ADMIN_USAGE_LOGS_LIMIT } from '@/lib/config';
import { ModelsAdmin } from './ModelsAdmin';

export default async function AdminModelsPage() {
  const supabase = createServiceClient();

  const { data: models } = await supabase
    .from('models_config')
    .select('id, provider, model_key, display_name, task_type, priority, enabled, temperature, max_output_tokens')
    .order('task_type')
    .order('priority');

  const { data: allLogs } = await supabase
    .from('model_usage_logs')
    .select('task_type, provider, model_key, success, latency_ms')
    .order('created_at', { ascending: false })
    .limit(ADMIN_USAGE_LOGS_LIMIT);

  return <ModelsAdmin initialModels={models ?? []} initialLogs={allLogs ?? []} />;
}
