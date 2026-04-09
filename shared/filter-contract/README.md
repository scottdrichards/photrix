# @photrix/filter-contract

Shared filter contract types used by both client and server.

## Purpose

This package is the canonical source for:
- Filter expression shape (`RecordFilterCondition`, `RecordFilterElement`)
- Client filter UI state (`ClientFilterState`)
- API filter option inputs (`ApiFilterOptions`)
- Field semantics (`filterFieldCapabilities`)

## Key semantics

- `undefined` means "no filter for this field".
- `null` is an explicit filter-state value for nullable fields (marked in `FIELD_METADATA`).
- Array fields in the UI are marked with `supportsArray: true` in `FIELD_METADATA`.

## Recommended usage

- Server: derive filter types from record models with `RecordFilterCondition` / `RecordFilterElement`.
- Client: import filter-related types directly from this package rather than redefining them.
- Keep JSDoc comments here so IntelliSense stays consistent across projects.
