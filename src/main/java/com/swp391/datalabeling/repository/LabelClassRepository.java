package com.swp391.datalabeling.repository;

import com.swp391.datalabeling.entity.LabelClass;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;

@Repository
public interface LabelClassRepository extends JpaRepository<LabelClass, Long> {
    List<LabelClass> findByProjectId(Long projectId);
}
