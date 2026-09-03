---
title: "find_sole_by in Rails"
description: "A simple note on using find_sole_by when your query should return exactly one record."
date: 2026-09-04
tags: [rails, activerecord]
---

Rails has many finder methods, and most of them are built around a simple idea: return the first matching record, return all matching records, or raise when nothing is found.

`find_sole_by` is a little stricter. It is useful when your code expects exactly one record to match a condition.

```ruby
User.find_sole_by(email: "sam@example.com")
```

This query has three possible outcomes:

- If exactly one user matches, Rails returns that user.
- If no users match, Rails raises `ActiveRecord::RecordNotFound`.
- If more than one user matches, Rails raises `ActiveRecord::SoleRecordExceeded`.

That last case is what makes `find_sole_by` interesting.

## Why not just use find_by?

`find_by` returns the first matching record:

```ruby
User.find_by(email: "sam@example.com")
```

If there are duplicate users with the same email, `find_by` will quietly return one of them. That may hide a data problem.

`find_sole_by` refuses to hide it. If the data says there is more than one matching row, Rails raises an error and makes the problem visible.

## Where it fits

Use `find_sole_by` when the query describes something that should be unique:

```ruby
Account.find_sole_by(subdomain: "acme")
Product.find_sole_by(sku: "TSHIRT-001")
Invitation.find_sole_by(token: params[:token])
```

It works well in code where returning the wrong record would be worse than raising an exception.

## Still add the unique index

`find_sole_by` is not a replacement for a database constraint. It helps your application notice unexpected duplicates, but it does not prevent duplicates from being created.

If the column should be unique, keep that rule in the database:

```ruby
add_index :users, :email, unique: true
```

The database protects the data. `find_sole_by` protects the assumption in the code.

## The short version

Use `find_by` when any matching record is acceptable.

Use `find_sole_by` when exactly one matching record must exist, and duplicate matches should be treated as a bug.
