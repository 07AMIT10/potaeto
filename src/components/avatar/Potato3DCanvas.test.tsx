import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Potato3DCanvas } from './Potato3DCanvas';

describe('Potato3DCanvas', () => {
  it('falls back to 2D avatar gracefully when WebGL is unavailable in test environment', () => {
    render(<Potato3DCanvas expression="happy" height={260} />);

    // In JSDOM, WebGL context is not supported, so it should render the 2D fallback or canvas container
    const fallback = screen.getByTestId('potato-2d-fallback');
    expect(fallback).toBeInTheDocument();
    expect(fallback.querySelector('svg')).toBeInTheDocument();
  });
});
