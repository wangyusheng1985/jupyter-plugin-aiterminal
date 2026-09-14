import { formatToolInput } from './tool';

describe('formatToolInput', () => {
  it('shows the Bash command with a prompt prefix', () => {
    expect(formatToolInput('Bash', { command: 'pwd' })).toBe('$ pwd');
    expect(
      formatToolInput('Bash', {
        command: 'ping -c 4 10.9.34.84 && nc -zv 10.9.34.84 22'
      })
    ).toBe('$ ping -c 4 10.9.34.84 && nc -zv 10.9.34.84 22');
  });

  it('compacts other tool inputs as key: value lines', () => {
    expect(formatToolInput('Read', { file_path: '/tmp/a.py' })).toBe(
      'file_path: /tmp/a.py'
    );
    expect(formatToolInput('Grep', { pattern: 'TODO', path: 'src' })).toBe(
      'pattern: TODO\npath: src'
    );
  });

  it('returns empty when there is nothing to show', () => {
    expect(formatToolInput('Bash', null)).toBe('');
    expect(formatToolInput('Bash', {})).toBe('{}');
  });
});
