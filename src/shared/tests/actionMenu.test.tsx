import { fireEvent, render } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { ActionMenu } from '@/shared/ui';

const LONG_PATH = '/workspace/' + 'very-long-folder-name/'.repeat(20);

function mockGeometry(width: number, height: number, left: number, top: number, triggerWidth = 32) {
  vi.stubGlobal('innerWidth', width);
  vi.stubGlobal('innerHeight', height);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const isMenu = this.getAttribute('role') === 'menu';
    const bounds = isMenu
      ? { x: 0, y: 0, width: 340, height: 288 }
      : { x: left, y: top, width: triggerWidth, height: 32 };
    return { ...bounds, left: bounds.x, top: bounds.y, right: bounds.x + bounds.width,
      bottom: bounds.y + bounds.height, toJSON: () => bounds };
  });
}

function openMenu(align: 'left' | 'right' = 'right') {
  const onSelect = vi.fn();
  const view = render(<ActionMenu label="Projects" portal menuWidth={340} align={align}
    items={[{ key: 'a', label: 'Alpha', description: LONG_PATH, onSelect }]} />);
  const trigger = view.getByRole('button', { name: 'Projects' });
  fireEvent.click(trigger);
  return { ...view, trigger, onSelect, menu: view.getByRole('menu') };
}

afterEach(() => vi.unstubAllGlobals());

test.each([220, 320, 1200])('a narrow anchor and long path stay within a %i px window', (width) => {
  mockGeometry(width, 800, 168, 100);
  const { menu, getByTitle } = openMenu();
  expect(menu.parentElement).toBe(document.body);
  const menuLeft = Number.parseFloat(menu.style.left);
  const menuWidth = Number.parseFloat(menu.style.width);
  expect(menuLeft).toBeGreaterThanOrEqual(8);
  expect(menuLeft + menuWidth).toBeLessThanOrEqual(width - 8);
  expect(getByTitle(LONG_PATH).textContent).toBe(LONG_PATH);
});

test.each([['left', 500], ['right', 360]] as const)('portal positioning honors %s alignment', (align, left) => {
  mockGeometry(1200, 800, 500, 100, 200);
  expect(openMenu(align).menu.style.left).toBe(left + 'px');
});

test('a menu near the bottom opens above its trigger', () => {
  mockGeometry(1200, 800, 500, 750);
  const { menu } = openMenu();
  expect(Number.parseFloat(menu.style.top) + Number.parseFloat(menu.style.maxHeight)).toBeLessThan(750);
});

test('a tall menu fits the available space and remains open while scrolling its items', () => {
  mockGeometry(500, 360, 100, 100);
  const { menu, queryByRole, trigger } = openMenu();
  expect(menu.style.maxHeight).toBe('214px');
  fireEvent.scroll(menu);
  expect(queryByRole('menu')).toBe(menu);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

test('selection closes the portal and still invokes the project action', () => {
  mockGeometry(500, 800, 100, 100);
  const view = openMenu();
  fireEvent.click(view.getByRole('menuitem', { name: /Alpha/ }));
  expect(view.onSelect).toHaveBeenCalledOnce();
  expect(view.queryByRole('menu')).toBeNull();
});
