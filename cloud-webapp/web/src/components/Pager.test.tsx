import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Pager } from './Pager.js';

describe('Pager', () => {
  it('renders nothing for a single page', () => {
    const { container } = render(<Pager page={0} pageCount={1} onChange={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows every page number when there are few pages (<= 7)', () => {
    render(<Pager page={0} pageCount={5} onChange={() => {}} />);
    for (let p = 1; p <= 5; p++) {
      expect(screen.getByRole('button', { name: `Page ${p}` })).toBeTruthy();
    }
    expect(screen.queryByText('…')).toBeNull();
  });

  it('windows with ellipses for many pages, always showing first and last', () => {
    render(<Pager page={9} pageCount={20} onChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Page 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Page 20' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Page 10' })).toBeTruthy();
    // Pages adjacent to the gaps are hidden behind ellipses.
    expect(screen.queryByRole('button', { name: 'Page 5' })).toBeNull();
    expect(screen.getAllByText('…').length).toBeGreaterThan(0);
  });

  it('disables Prev on the first page and Next on the last', () => {
    const { rerender } = render(<Pager page={0} pageCount={3} onChange={() => {}} />);
    expect((screen.getByRole('button', { name: 'Previous page' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Next page' }) as HTMLButtonElement).disabled).toBe(false);

    rerender(<Pager page={2} pageCount={3} onChange={() => {}} />);
    expect((screen.getByRole('button', { name: 'Previous page' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Next page' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('marks the current page with aria-current', () => {
    render(<Pager page={1} pageCount={3} onChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Page 2' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: 'Page 1' }).getAttribute('aria-current')).toBeNull();
  });

  it('reports 0-indexed page changes', () => {
    const onChange = vi.fn();
    render(<Pager page={0} pageCount={3} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Page 3' }));
    expect(onChange).toHaveBeenCalledWith(2);
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(onChange).toHaveBeenCalledWith(1);
  });
});
