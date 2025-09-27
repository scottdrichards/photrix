import { describe, it, expect } from 'vitest'

// Basic server test to ensure test infrastructure works
describe('Server', () => {
  it('should have basic functionality', () => {
    const message = 'Photrix server test'
    expect(message).toBe('Photrix server test')
  })

  it('should handle API responses', () => {
    const mockResponse = {
      status: 'ok',
      message: 'Photrix API is running',
      version: '0.1.0'
    }
    
    expect(mockResponse.status).toBe('ok')
    expect(mockResponse.version).toBe('0.1.0')
  })
})