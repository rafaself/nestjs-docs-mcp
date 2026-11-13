### Fixture **Introduction**

An introductory paragraph with a [provider link](/providers).

#### Setup

An object can be written as `{{ '{' }} ready: true {{ '}' }}`.

<app-banner-courses></app-banner-courses>
#### Examples

```typescript
@@filename(example.service)
export class ExampleService {
  value = 'typescript';
}
// # This is code, not a heading.
console.log("{{ '{' }}");
@@switch
export class ExampleService {
  value = 'javascript';
}
```

##### Nested section

> info **Hint** Keep this callout and its meaning.

| Name | Value |
| --- | --- |
| fixture | example |

#### Setup

A second section with the same heading.

#### Setup-1

A heading whose name collides with the previous generated anchor.
