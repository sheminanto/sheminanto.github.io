---
title: "create_or_find_by and find_or_create_by are not the same in Rails"
description: "A short note on why these two Rails methods look similar but behave differently under concurrency."
date: 2026-09-04
tags: [rails, activerecord]
---

Rails gives us both `find_or_create_by` and `create_or_find_by`, and the names make them look like harmless variations of the same idea. They are not.

The difference is the order of work, and that order matters when more than one process is trying to create the same record.

## find_or_create_by

`find_or_create_by` first runs a `SELECT`. If no row is found, it then runs an `INSERT`.

That is easy to read, but there is a race condition between the find and the create:

```ruby
User.find_or_create_by(email: "sam@example.com")
```

If two requests run this at the same time, both can fail to find the user. Then both can try to insert it. Without a database-level unique constraint, you can end up with duplicate rows.

Even with a unique constraint, one request may raise an error because the other request inserted the row first.

## create_or_find_by

`create_or_find_by` flips the order. It first tries to `INSERT`. If the insert fails because of a unique constraint, Rails catches that conflict and then runs a `SELECT` to return the existing row.

```ruby
User.create_or_find_by(email: "sam@example.com")
```

This method expects the database to protect uniqueness. It is designed for cases where a duplicate insert is possible and normal under concurrency.

## The practical rule

Use `find_or_create_by` when the record probably already exists and the operation is not under heavy contention.

Use `create_or_find_by` when many processes may try to create the same record at the same time, and make sure the relevant columns have a unique index:

```ruby
add_index :users, :email, unique: true
```

The database constraint is not optional. `create_or_find_by` relies on it to know that another process already created the row.

## One more detail

`create_or_find_by` can consume an auto-increment primary key value even when the insert fails. For most modern applications this is not a practical problem, but it is worth knowing if you are working with a table that still has a limited integer primary key range.

The short version: `find_or_create_by` is find first, create second. `create_or_find_by` is create first, find second. That small difference is exactly what changes the concurrency behavior.
