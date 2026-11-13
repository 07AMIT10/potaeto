import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ModelPicker } from './ModelPicker';
import { useCore } from '@/components/providers/CoreProvider';

vi.mock('@/components/providers/CoreProvider', () => ({
  useCore: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ModelPicker component', () => {
  const mockCatalog = {
    models: [
      {
        provider: 'provider_1',
        id: 'model_a',
        name: 'Model A',
        contextLength: 128000,
        maxOutputTokens: 4096,
        supportsTools: true,
        protocol: 'openai',
        pricing: null,
        retention: null,
      },
    ],
    activeModel: 'model_a',
    activeProvider: 'provider_1',
  };

  it('renders nothing when offline or no models', async () => {
    vi.mocked(useCore).mockReturnValue({
      online: false,
      client: {
        listModels: vi.fn().mockResolvedValue({ models: [] }),
        getModelUsage: vi.fn().mockResolvedValue(null),
      },
    } as any);

    const { container } = render(<ModelPicker />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders model select and compact usage badge when usage data is available', async () => {
    vi.mocked(useCore).mockReturnValue({
      online: true,
      client: {
        listModels: vi.fn().mockResolvedValue(mockCatalog),
        getModelUsage: vi.fn().mockResolvedValue({
          total_tokens_in: 12500,
          total_tokens_out: 4200,
          total_cost: 0.05,
          call_count: 14,
          by_provider: {},
          by_model: {},
        }),
      },
    } as any);

    render(<ModelPicker />);

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: /model/i })).toBeInTheDocument();
    });

    const badge = await screen.findByTestId('model-usage-badge');
    expect(badge).toBeInTheDocument();
    // 12500 + 4200 = 16700 -> 16.7k tok
    expect(badge).toHaveTextContent('16.7k tok');
    expect(badge).toHaveTextContent('$0.05');
  });
});
