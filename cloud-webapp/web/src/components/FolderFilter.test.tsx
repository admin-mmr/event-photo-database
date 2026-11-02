import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FolderFilter } from './FolderFilter.js';
import { clubOptions, tagOptions } from '../lib/galleryFolders.js';

const FOLDERS = [
  { clubName: 'Harriers', tag: 'ALL', count: 4 },
  { clubName: 'MMR', tag: '', count: 1 },
  { clubName: 'MMR', tag: '10K', count: 2 },
  { clubName: 'MMR', tag: '5K', count: 3 },
];

const optionTexts = (name: string): string[] =>
  Array.from(screen.getByRole('combobox', { name }).querySelectorAll('option')).map(
    (o) => o.textContent ?? '',
  );

describe('clubOptions / tagOptions', () => {
  it('sums a club across its tags, including photos filed with no tag', () => {
    expect(clubOptions(FOLDERS)).toEqual([
      { value: 'Harriers', count: 4 },
      { value: 'MMR', count: 6 },
    ]);
  });

  it("lists only the club's named tags", () => {
    expect(tagOptions(FOLDERS, 'MMR')).toEqual([
      { value: '10K', count: 2 },
      { value: '5K', count: 3 },
    ]);
  });
});

describe('FolderFilter', () => {
  it('renders nothing for an event with no club folders', () => {
    const { container } = render(<FolderFilter folders={[]} club="" tag="" onChange={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('defaults to all clubs, with no tag menu until a club is chosen', () => {
    render(<FolderFilter folders={FOLDERS} club="" tag="" onChange={() => {}} />);
    expect(optionTexts('Filter by club')).toEqual(['All clubs', 'Harriers (4)', 'MMR (6)']);
    expect(screen.queryByRole('combobox', { name: 'Filter by tag' })).toBeNull();
  });

  it("offers the chosen club's tags", () => {
    render(<FolderFilter folders={FOLDERS} club="MMR" tag="" onChange={() => {}} />);
    expect(optionTexts('Filter by tag')).toEqual(['All tags', '10K (2)', '5K (3)']);
  });

  it('hides the tag menu for a club with a single tag, which would repeat the club', () => {
    render(<FolderFilter folders={FOLDERS} club="Harriers" tag="" onChange={() => {}} />);
    expect(screen.queryByRole('combobox', { name: 'Filter by tag' })).toBeNull();
  });

  it('labels the default ALL tag as "No tag"', () => {
    render(<FolderFilter folders={FOLDERS} club="Harriers" tag="ALL" onChange={() => {}} />);
    expect(optionTexts('Filter by tag')).toEqual(['All tags', 'No tag (4)']);
  });

  it('choosing a club clears the tag; choosing a tag keeps the club', () => {
    const onChange = vi.fn();
    render(<FolderFilter folders={FOLDERS} club="MMR" tag="10K" onChange={onChange} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by club' }), {
      target: { value: 'Harriers' },
    });
    expect(onChange).toHaveBeenLastCalledWith('Harriers', '');
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by tag' }), {
      target: { value: '5K' },
    });
    expect(onChange).toHaveBeenLastCalledWith('MMR', '5K');
  });

  it('keeps an unknown selected club visible so it can be cleared', () => {
    render(<FolderFilter folders={[]} club="Gone" tag="" onChange={() => {}} />);
    expect(optionTexts('Filter by club')).toEqual(['All clubs', 'Gone']);
  });
});
