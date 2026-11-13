# Authorization guards

## Inspecting request context

A guard evaluates a request before its controller handler runs. Nest passes an
`ExecutionContext` to the guard, so it can inspect the active request,
controller, and handler metadata before deciding whether to allow access.

```ts
@Injectable()
export class RolesGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    return true;
  }
}
```
